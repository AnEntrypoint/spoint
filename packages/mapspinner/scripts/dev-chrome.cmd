@echo off
rem mapspinner dev Chrome launcher -- kills the 150s cold shader compile (measured 2026-06-10).
rem
rem The ~150s cold compile of terrain.glsl is the ANGLE D3D11 backend's FXC
rem HLSL-optimize pass (default Chrome on Windows). Switching the ANGLE backend
rem removes FXC entirely; same shader source, measured cold shaderCompileMs:
rem   d3d11 (default) : 152379 ms
rem   opengl          :   4653 ms cold / 96 ms warm (NVIDIA GL driver cache)
rem   vulkan          :    140 ms
rem Every shader EDIT recompiles cold, so on vulkan the edit loop is ~0.1s not 150s.
rem
rem Usage: scripts\dev-chrome.cmd [gl|d3d11]   (default: vulkan)
rem A persistent profile keeps driver/browser caches warm across runs.

set BACKEND=vulkan
if /i "%1"=="gl"    set BACKEND=gl
if /i "%1"=="d3d11" set BACKEND=d3d11

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

%CHROME% --user-data-dir="%~dp0..\.gm\tmp\chrome-dev-%BACKEND%" --use-angle=%BACKEND% --remote-debugging-port=9222 --no-first-run --no-default-browser-check http://localhost:8080/
