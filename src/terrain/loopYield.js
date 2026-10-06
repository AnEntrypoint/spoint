export const yieldToLoop = () => new Promise(r => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)))
