#!/usr/bin/env python3
"""Attach to the camera stream through PipeWire and print a center-weighted
mean luminance (0-255) once per interval. One value per line on stdout."""
import signal
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

W, H = 32, 24
# Weight the middle of the frame (where a face usually is) over the edges.
WEIGHTS = [
    1.0 if (W // 4 <= x < 3 * W // 4 and H // 6 <= y < 5 * H // 6) else 0.25
    for y in range(H)
    for x in range(W)
]
WSUM = sum(WEIGHTS)


def main():
    interval = max(1, int(float(sys.argv[1]))) if len(sys.argv) > 1 else 2
    Gst.init(None)
    pipe = Gst.parse_launch(
        'pipewiresrc client-name=studiolight-helper '
        'stream-properties="props,node.name=studiolight-helper" '
        '! decodebin ! videoconvert ! videoscale '
        '! videorate drop-only=true '
        f'! video/x-raw,format=GRAY8,width={W},height={H},framerate=1/{interval} '
        '! appsink name=sink sync=false max-buffers=1 drop=true'
    )
    sink = pipe.get_by_name("sink")

    def shutdown(*_):
        pipe.set_state(Gst.State.NULL)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    pipe.set_state(Gst.State.PLAYING)
    idle = 0
    while True:
        sample = sink.try_pull_sample((interval + 3) * Gst.SECOND)
        if sample is None:
            idle += 1
            if sink.is_eos() or idle >= 4:
                break
            continue
        idle = 0
        buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        if not ok:
            continue
        data = bytes(info.data)
        buf.unmap(info)
        if len(data) < W * H:
            continue
        mean = sum(p * w for p, w in zip(data, WEIGHTS)) / WSUM
        print(f"{mean:.2f}", flush=True)

    pipe.set_state(Gst.State.NULL)
    sys.exit(1)


if __name__ == "__main__":
    main()
