# Audio integration

Application composition creates the bus graph, supplies decoded clips from
`@ink/assets`, and constructs `AudioDevice` with `create_web_audio_output()`.
The undefined result is intentional no-audio operation and must not stop the
runtime or semantic UI.

On a user activation, call `device.activate()`. Each presentation frame maps
game sound intent into one ordered `command_batch`, applies it through
`AudioMixer`, and submits the ready plan to the device. Camera and scene owners
resolve listeners and emitters before calling `spatial_mix`. Output changes call
`interrupt` and then `recover` with a monotonically increasing attempt number.
