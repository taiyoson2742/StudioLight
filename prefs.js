import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StudioLightPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep a reference alive

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Behaviour'),
            description: _('Studio Light only raises brightness; it never dims below your own setting.'),
        });

        const sens = new Adw.SpinRow({
            title: _('Sensitivity'),
            subtitle: _('Higher values start boosting in brighter rooms'),
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1, step_increment: 0.05}),
        });
        settings.bind('sensitivity', sens, 'value', Gio.SettingsBindFlags.DEFAULT);

        const max = new Adw.SpinRow({
            title: _('Maximum brightness (%)'),
            adjustment: new Gtk.Adjustment({lower: 20, upper: 100, step_increment: 5}),
        });
        settings.bind('max-brightness', max, 'value', Gio.SettingsBindFlags.DEFAULT);

        const interval = new Adw.SpinRow({
            title: _('Sample interval (seconds)'),
            subtitle: _('Longer intervals use less CPU. Applies on the next call.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1}),
        });
        settings.bind('sample-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        group.add(sens);
        group.add(max);
        group.add(interval);
        page.add(group);
        window.add(page);
    }
}
