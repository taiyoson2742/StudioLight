/* extension.js - Studio Light
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const ICON = 'display-brightness-symbolic';
const POLL_SECONDS = 3;
const HELPER_NAME = 'studiolight';
const SHUTTER_LUMA = 2;      // readings below this are treated as a closed shutter
const HYSTERESIS = 3;        // minimum change (%) before we retarget
const ANIM_STEP = 2;         // % per animation tick
const ANIM_MS = 80;

/* ---------------------------------------------------------------- brightness */

const PWR_BUS = 'org.gnome.SettingsDaemon.Power';
const PWR_PATH = '/org/gnome/SettingsDaemon/Power';
const PWR_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

class Brightness {
    /** @returns {Promise<number>} 0-100, or -1 if unavailable */
    async get() {
        try {
            const reply = await Gio.DBus.session.call(
                PWR_BUS, PWR_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PWR_IFACE, 'Brightness']),
                null, Gio.DBusCallFlags.NONE, -1, null);
            return reply.get_child_value(0).get_variant().get_int32();
        } catch (e) {
            return -1;
        }
    }

    set(value) {
        const v = Math.max(1, Math.min(100, Math.round(value)));
        Gio.DBus.session.call(
            PWR_BUS, PWR_PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PWR_IFACE, 'Brightness', new GLib.Variant('i', v)]),
            null, Gio.DBusCallFlags.NONE, -1, null)
            .catch(e => console.error(`Studio Light: set brightness failed: ${e.message}`));
    }
}

/* ------------------------------------------------------------ camera in use? */

/**
 * True if some client other than our own helper has an active link from a
 * Video/Source node (i.e. an app is streaming from the camera).
 */
function cameraInUse(pwDumpJson) {
    const objs = JSON.parse(pwDumpJson);
    const nodes = new Map();
    for (const o of objs) {
        if (o.type === 'PipeWire:Interface:Node')
            nodes.set(o.id, o.info?.props ?? {});
    }
    for (const o of objs) {
        if (o.type !== 'PipeWire:Interface:Link' || o.info?.state !== 'active')
            continue;
        const out = nodes.get(o.info['output-node-id']);
        const inp = nodes.get(o.info['input-node-id']);
        if (!out || !inp || out['media.class'] !== 'Video/Source')
            continue;
        const who = `${inp['node.name'] ?? ''} ${inp['application.name'] ?? ''}`.toLowerCase();
        if (who.includes(HELPER_NAME))
            continue;
        return true;
    }
    return false;
}

/* ---------------------------------------------------------------- controller */

class Controller {
    constructor(path, settings, onState) {
        this._path = path;
        this._settings = settings;
        this._onState = onState;
        this._brightness = new Brightness();
        this._cancellable = new Gio.Cancellable();

        this._pollId = 0;
        this._polling = false;
        this._helper = null;
        this._active = false;

        this._baseline = null;   // the user's own brightness
        this._lastSet = null;    // last value we wrote
        this._target = null;
        this._ema = null;
        this._animId = 0;

        this._enabledId = settings.connect('changed::enabled', () => this._applyEnabled());
        this._recoverFromCrash();
        this._applyEnabled();
    }

    destroy() {
        this._settings.disconnect(this._enabledId);
        this._cancellable.cancel();
        this._stopPolling();
        this._killHelper();
        if (this._animId) {
            GLib.source_remove(this._animId);
            this._animId = 0;
        }
        if (this._baseline !== null) {
            this._brightness.set(this._baseline);
            this._settings.set_int('saved-brightness', -1);
        }
    }

    /* -- lifecycle -- */

    _recoverFromCrash() {
        const saved = this._settings.get_int('saved-brightness');
        if (saved >= 0) {
            this._brightness.set(saved);
            this._settings.set_int('saved-brightness', -1);
        }
    }

    _applyEnabled() {
        if (this._settings.get_boolean('enabled')) {
            this._onState('waiting');
            this._startPolling();
        } else {
            this._stopPolling();
            this._endSession();
            this._onState('off');
        }
    }

    _startPolling() {
        if (this._pollId)
            return;
        this._poll();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    async _poll() {
        if (this._polling)
            return;
        this._polling = true;
        try {
            const proc = Gio.Subprocess.new(['pw-dump'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!this._settings.get_boolean('enabled'))
                return;
            const inUse = cameraInUse(stdout);
            if (inUse && !this._active)
                this._beginSession();
            else if (!inUse && this._active)
                this._endSession();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`Studio Light: camera check failed: ${e.message}`);
        } finally {
            this._polling = false;
        }
    }

    /* -- session (camera in use) -- */

    async _beginSession() {
        this._active = true;
        this._ema = null;
        this._launchHelper();

        if (this._baseline === null) {
            const cur = await this._brightness.get();
            if (!this._active)
                return;
            if (cur < 0) {
                console.warn('Studio Light: brightness control unavailable');
                this._endSession();
                return;
            }
            this._baseline = cur;
            this._lastSet = cur;
            this._target = cur;
            this._settings.set_int('saved-brightness', cur);
        }
        this._onState('active');
    }

    _endSession() {
        this._active = false;
        this._killHelper();
        this._ema = null;
        if (this._baseline !== null) {
            this._target = this._baseline;
            this._startAnim();
        }
        if (this._settings.get_boolean('enabled'))
            this._onState('waiting');
    }

    /* -- helper process -- */

    _launchHelper() {
        if (this._helper)
            return;
        try {
            const interval = String(this._settings.get_int('sample-interval'));
            const proc = Gio.Subprocess.new(
                ['python3', GLib.build_filenamev([this._path, 'camera-luma.py']), interval],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._helper = proc;
            const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            this._readLoop(proc, stream);
        } catch (e) {
            console.error(`Studio Light: cannot start helper: ${e.message}`);
        }
    }

    _killHelper() {
        if (this._helper) {
            this._helper.force_exit();
            this._helper = null;
        }
    }

    async _readLoop(proc, stream) {
        try {
            while (this._helper === proc) {
                const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
                if (line === null)
                    break;
                await this._onLuma(parseFloat(line));
            }
        } catch (e) {
            // cancelled or pipe closed
        }
        // Helper died on its own: clear it so the next poll can relaunch.
        if (this._helper === proc)
            this._helper = null;
    }

    /* -- brightness logic -- */

    _desiredTarget(luma) {
        const l = luma / 255;
        const sens = this._settings.get_double('sensitivity');
        const threshold = 0.15 + 0.5 * sens;                 // 0.15 .. 0.65
        const factor = Math.min(1, Math.max(0, (threshold - l) / threshold));
        const max = this._settings.get_int('max-brightness');
        const span = Math.max(0, max - this._baseline);
        return Math.round(this._baseline + span * factor);   // never dims below baseline
    }

    async _onLuma(luma) {
        if (!Number.isFinite(luma) || luma < SHUTTER_LUMA || !this._active || this._baseline === null)
            return;

        this._ema = this._ema === null ? luma : 0.6 * luma + 0.4 * this._ema;

        // Detect the user (or the power daemon) changing brightness behind our back.
        if (!this._animId) {
            const cur = await this._brightness.get();
            if (!this._active || cur < 0)
                return;
            if (Math.abs(cur - this._lastSet) > 2) {
                this._baseline = cur;
                this._lastSet = cur;
                this._target = cur;
                this._settings.set_int('saved-brightness', cur);
            }
        }

        const desired = this._desiredTarget(this._ema);
        if (Math.abs(desired - this._target) < HYSTERESIS)
            return;
        this._target = desired;
        this._startAnim();
    }

    _startAnim() {
        if (this._animId)
            return;
        this._animId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIM_MS, () => {
            const diff = this._target - this._lastSet;
            if (diff === 0) {
                this._animId = 0;
                if (!this._active) {
                    // Finished restoring the user's brightness.
                    this._baseline = null;
                    this._lastSet = null;
                    this._settings.set_int('saved-brightness', -1);
                }
                return GLib.SOURCE_REMOVE;
            }
            this._lastSet += Math.sign(diff) * Math.min(Math.abs(diff), ANIM_STEP);
            this._brightness.set(this._lastSet);
            return GLib.SOURCE_CONTINUE;
        });
    }
}

/* ----------------------------------------------------------------------- UI */

const StudioLightToggle = GObject.registerClass(
class StudioLightToggle extends QuickMenuToggle {
    constructor(extension, settings) {
        super({
            title: _('Studio Light'),
            iconName: ICON,
            toggleMode: true,
        });

        this.menu.setHeader(ICON, _('Studio Light'),
            _('Brightens the screen in dim rooms while the camera is in use'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Sensitivity')));
        const sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        const slider = new Slider(settings.get_double('sensitivity'));
        slider.x_expand = true;
        slider.connect('notify::value', () => settings.set_double('sensitivity', slider.value));
        sliderItem.add_child(slider);
        this.menu.addMenuItem(sliderItem);

        this.menu.addAction(_('Settings'), () => extension.openPreferences());

        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
    }
});

const StudioLightIndicator = GObject.registerClass(
class StudioLightIndicator extends SystemIndicator {
    constructor(extension, settings) {
        super();
        this._indicator = this._addIndicator();
        this._indicator.iconName = ICON;
        this._indicator.visible = false;

        this._toggle = new StudioLightToggle(extension, settings);
        this.quickSettingsItems.push(this._toggle);
    }

    setState(state) {
        this._indicator.visible = state === 'active';
        switch (state) {
        case 'active':
            this._toggle.subtitle = _('Camera in use');
            break;
        case 'waiting':
            this._toggle.subtitle = _('Waiting for camera');
            break;
        default:
            this._toggle.subtitle = null;
        }
    }
});

/* ---------------------------------------------------------------- extension */

export default class StudioLightExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new StudioLightIndicator(this, this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._controller = new Controller(this.path, this._settings,
            state => this._indicator?.setState(state));
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;
        this._indicator?.quickSettingsItems.forEach(item => item.destroy());
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
