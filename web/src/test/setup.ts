import '@testing-library/jest-dom/vitest'

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => undefined
if (!window.matchMedia) window.matchMedia = (() => ({ matches:false, media:'', onchange:null, addListener:() => undefined, removeListener:() => undefined, addEventListener:() => undefined, removeEventListener:() => undefined, dispatchEvent:() => false })) as typeof window.matchMedia
