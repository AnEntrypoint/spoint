Never chromium.launch()/playwright directly for live checks -- browser verb only. A crashed script orphans Chromium, causing GPU contention that mimics a perf regression.
