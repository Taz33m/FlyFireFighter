# FlyVis reference subset

Source: [TuragaLab/flyvis](https://github.com/TuragaLab/flyvis), commit **0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa**. Copied November 7, 2026 under the upstream [MIT license](license). Copyright and permission notice are retained unchanged.

This is an **unmodified reference subset**, not an installed package, a complete fork, pretrained weights or a working flight controller. The manifest lists each copied upstream path and Git blob SHA-1. All ten file hashes were checked after copying; Python files also parse. Upstream tests have not been executed in this repo because their full package/runtime is not installed.

## Integration map

| File | Use |
| --- | --- |
| [eye.py](flyvis/datasets/rendering/eye.py) | `BoxEye` sampling and input shape reference; preserve calibration and luminance conventions. |
| [network.py](flyvis/network/network.py) | Network dynamics, stimulus shape, steady-state initialization and recurrent-state handling. |
| [network_view.py](flyvis/network/network_view.py) | Checkpoint recovery and model metadata. |
| [stimulus.py](flyvis/network/stimulus.py) | Input buffer conventions. |
| [decoder.py](flyvis/task/decoder.py) | Activity selection and readout architecture patterns. |
| [objectives.py](flyvis/task/objectives.py) | Existing learning objectives to inspect when defining our own controller loss. |
| [test_rendering.py](tests/test_rendering.py), [test_network.py](tests/test_network.py) | Upstream behavior to preserve; separate from our future scenario tests. |
| [pyproject.toml](pyproject.toml) | Upstream dependencies and Python compatibility. |

Install the complete upstream package at the pinned commit in a dedicated Python 3.11 environment when building `services/flyvis`. Do not add this partial directory to `PYTHONPATH`. Record pretrained checkpoint source, hash and applicable license separately; the source license does not by itself verify the provenance of downloaded weights or datasets.

Keep upstream copies unchanged. Put adapters and new trained readouts in our own modules with source attribution. If a copied implementation must change, record the modification and baseline in [manifest.json](manifest.json); do not retain `modified: false` or claim its new bytes match upstream.

See [architecture.md](../../architecture.md) for the actual camera → neural model → trained readout → harness design. No inferred motion, speed or rescue capability is implied by vendoring these files.
