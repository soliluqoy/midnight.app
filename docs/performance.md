# Performance baseline

Measured 2026-10-04 on the development machine (Windows 10 Pro x64, 8 logical cores), isolated profile, no model
signed in, capsule idle on screen. Command: `MIDNIGHT_PERF=150 MIDNIGHT_USER_DATA=… MIDNIGHT_CORE_DIR=… electron .`
(samples every Midnight process with `app.getAppMetrics()`).

| Run | CPU median (one core) | CPU p95 | Machine-normalized median | Private memory median |
|---|---|---|---|---|
| Breathing dot animating `box-shadow` (original CSS) | 3.98% | 4.33% | 0.497% | 304 MB |
| Reduced motion (no animation) | 0.02% | 1.04% | 0.002% | 280 MB |
| Dot animated with transform/opacity only | 3.13% | 3.88% | 0.392% | 288 MB |
| **Current: dot rests after a quiet minute** | **0.03%** | 3.54% (first minute) | **0.004%** | **243 MB** |

Targets from the plan (ch. 09): quiet CPU median < 0.5% and p95 < 2% of the machine (met); settled private memory
< 250 MB (met at the median; startup p95 is ~318 MB); zero model calls when idle (met: watches use deterministic checks).
Not yet measured: a model task, browser and desktop tasks, a 24-hour watch soak, battery drain, 100-mission leak slope.
