// Vendored verbatim from ../thebird/docs/vendor/kits/os/wm.js. Pure DOM paint; WindowController.js owns z-order/focus/drag/resize math.
export function renderWindow(opts = {}) {
    const {
        title = 'window',
        body = null,
        bounds = { x: 60, y: 60, w: 480, h: 320 },
        focused = false,
        maximized = false,
        minimized = false,
        instanceId = '',
        kind = 'div',
        callbacks = {},
    } = opts;

    const el = document.createElement('div');
    el.className = 'wm-win';
    el.dataset.kind = kind;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    if (instanceId) el.dataset.instanceId = instanceId;
    el.style.left = bounds.x + 'px';
    el.style.top = bounds.y + 'px';
    el.style.width = bounds.w + 'px';
    el.style.height = bounds.h + 'px';

    const bar = document.createElement('div');
    bar.className = 'wm-bar';
    const titleEl = document.createElement('span');
    titleEl.className = 'wm-title';
    titleEl.textContent = title;
    const btns = document.createElement('div');
    btns.className = 'wm-btns';
    const minBtn = mkBtn('-', 'minimize');
    const maxBtn = mkBtn('+', 'maximize');
    const closeBtn = mkBtn('x', 'close');
    btns.append(minBtn, maxBtn, closeBtn);
    bar.append(titleEl, btns);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'wm-body';
    setBodyContent(bodyEl, body);

    const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const grips = DIRS.map(dir => {
        const g = document.createElement('div');
        g.className = dir === 'se' ? 'wm-resize' : 'wm-edge';
        g.dataset.dir = dir;
        return g;
    });

    el.append(bar, bodyEl, ...grips);

    minBtn.addEventListener('click', e => { e.stopPropagation(); callbacks.onMinimize && callbacks.onMinimize(); });
    maxBtn.addEventListener('click', e => { e.stopPropagation(); callbacks.onMaximize && callbacks.onMaximize(); });
    closeBtn.addEventListener('click', e => { e.stopPropagation(); callbacks.onClose && callbacks.onClose(); });

    const focus = () => callbacks.onFocus && callbacks.onFocus();

    el.addEventListener('pointerdown', () => focus());

    bar.addEventListener('pointerdown', e => {
        if (e.target.closest('.wm-btn')) return;
        e.stopPropagation();
        focus();
        if (callbacks.onDragStart) callbacks.onDragStart(e, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    });

    grips.forEach(g => g.addEventListener('pointerdown', e => {
        e.stopPropagation();
        focus();
        if (callbacks.onResizeStart) callbacks.onResizeStart(e, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, dir: g.dataset.dir });
    }));

    applyFocused(el, focused);
    applyMaximized(el, maximized);
    applyMinimized(el, minimized);

    return {
        el,
        setTitle(t) { titleEl.textContent = t; el.setAttribute('aria-label', t); },
        setBody(b) { setBodyContent(bodyEl, b); },
        setBounds(b) {
            if (typeof b.x === 'number') el.style.left = b.x + 'px';
            if (typeof b.y === 'number') el.style.top = b.y + 'px';
            if (typeof b.w === 'number') el.style.width = b.w + 'px';
            if (typeof b.h === 'number') el.style.height = b.h + 'px';
        },
        setFocused(v) { applyFocused(el, v); },
        setMaximized(v) { applyMaximized(el, v); },
        setMinimized(v) { applyMinimized(el, v); },
        setInstanceId(id) { if (id) el.dataset.instanceId = id; else delete el.dataset.instanceId; },
        setZIndex(z) { el.style.zIndex = String(z); },
        getBounds() { return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }; },
        dispose() { el.remove(); },
    };
}

function mkBtn(label, ttl) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wm-btn';
    b.textContent = label;
    b.title = ttl;
    b.setAttribute('aria-label', ttl);
    return b;
}

function setBodyContent(host, body) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (body instanceof Node) host.appendChild(body);
    else if (typeof body === 'string') host.innerHTML = body;
}

function applyFocused(el, v) { el.classList.toggle('wm-focused', !!v); }
function applyMaximized(el, v) { el.classList.toggle('wm-max', !!v); }
function applyMinimized(el, v) { el.classList.toggle('wm-min', !!v); }
