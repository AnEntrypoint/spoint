Wrap browser-verb scripts in `await page.evaluate(()=>{...})`, never bare top-level window.*; bare form can silently drop page-context between dispatches (window-is-not-defined vm fallback).
