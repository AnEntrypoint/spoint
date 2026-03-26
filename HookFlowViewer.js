import { createElement, applyDiff } from 'webjsx'
const h = createElement

const CAT = {
  lifecycle: '#34d399', input: '#60a5fa', editor: '#f472b6',
  interact: '#fbbf24', state: '#34d399', motion: '#60a5fa', custom: '#94a3b8'
}
const C = (cat) => CAT[cat] || CAT.custom

function buildGraph(entities) {
  return entities
    .filter(e => e._appName || e.appName)
    .map((e, i) => ({ id: e.id, label: e.id, kind: e._appName || e.appName,
      x: (i % 3) * 340 + 24, y: Math.floor(i / 3) * 180 + 24 }))
}

function nodeCard(n, sel) {
  const c = sel ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.06)'
  const bg = sel ? '0 0 0 1px rgba(16,185,129,0.25),0 12px 48px rgba(0,0,0,0.55),0 0 24px rgba(16,185,129,0.08)' : '0 12px 48px rgba(0,0,0,0.55)'
  return '<g class="hf-node" data-id="' + n.id + '" transform="translate(' + n.x + ',' + n.y + ')" style="cursor:pointer">'
    + '<rect width="300" height="96" rx="14" fill="#0a1410" stroke="' + c + '" stroke-width="1" style="filter:drop-shadow(' + bg + ')"/>'
    + '<rect width="300" height="36" rx="14" fill="rgba(16,185,129,0.08)"/>'
    + '<rect y="26" width="300" height="10" fill="rgba(16,185,129,0.08)"/>'
    + '<text x="14" y="23" font-family="monospace" font-size="11" fill="rgba(255,255,255,0.9)" font-weight="600">' + n.label + '</text>'
    + '<text x="286" y="23" font-family="monospace" font-size="8" fill="rgba(255,255,255,0.38)" font-weight="700" text-anchor="end" letter-spacing="1">' + n.kind.toUpperCase().slice(0,14) + '</text>'
    + '<text x="14" y="58" font-family="monospace" font-size="9" fill="rgba(16,185,129,0.6)">● setup</text>'
    + '<text x="80" y="58" font-family="monospace" font-size="9" fill="rgba(96,165,250,0.6)">● update</text>'
    + '<text x="158" y="58" font-family="monospace" font-size="9" fill="rgba(244,114,182,0.6)">● onInteract</text>'
    + '<text x="14" y="78" font-family="monospace" font-size="9" fill="rgba(148,163,184,0.5)">● onEditorUpdate</text>'
    + '</g>'
}

export function createHookFlowViewer(container) {
  let _ents = [], _sel = null, _tx = 0, _ty = 0, _sc = 1, _drag = false, _dx = 0, _dy = 0, _onClick = null

  function render() {
    const nodes = buildGraph(_ents)
    const W = container.offsetWidth || 600, H = container.offsetHeight || 400
    const inner = nodes.length === 0
      ? '<text x="' + W/2 + '" y="' + H/2 + '" text-anchor="middle" font-family="monospace" font-size="12" fill="rgba(255,255,255,0.22)">No app entities in scene</text>'
      : nodes.map(n => nodeCard(n, n.id === _sel)).join('')
    applyDiff(container, h('div', { style: 'width:100%;height:100%;overflow:hidden;position:relative' },
      h('svg', { style: 'width:100%;height:100%', xmlns: 'http://www.w3.org/2000/svg',
        onMousedown: e => { if (e.target.closest?.('.hf-node')) return; _drag=true; _dx=e.clientX-_tx; _dy=e.clientY-_ty; e.currentTarget.style.cursor='grabbing' },
        onMousemove: e => { if (!_drag) return; _tx=e.clientX-_dx; _ty=e.clientY-_dy; render() },
        onMouseup: e => { _drag=false; e.currentTarget.style.cursor='grab' },
        onWheel: e => { e.preventDefault(); const f=e.deltaY>0?0.88:1.14; _sc=Math.min(4,Math.max(0.1,_sc*f)); render() },
        onClick: e => { const n=e.target.closest?.('.hf-node'); if (n) { _sel=n.dataset.id; _onClick?.(_sel); render() } },
        dangerouslySetInnerHTML: { __html: '<g transform="translate('+_tx+','+_ty+') scale('+_sc+')">'+inner+'</g>' }
      })
    ))
  }

  render()
  return {
    updateGraph(ents) { _ents = ents || []; render() },
    onNodeClick(cb) { _onClick = cb }
  }
}
