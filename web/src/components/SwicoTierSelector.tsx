import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { AssistantSettings, SwicoTier } from '../types'

export function SwicoTierSelector({ assistant, disabled = false, saving = false, onSelect, context = 'header' }: {
  assistant: AssistantSettings; disabled?: boolean; saving?: boolean;
  onSelect: (tier: SwicoTier) => Promise<void> | void; context?: 'header' | 'settings' | 'composer';
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const unavailable = disabled || saving || !assistant.tier_selection_enabled

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0)
  }
  const focusOption = (index: number) => {
    const options = assistant.tiers
    if (!options.length) return
    let next = index
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      if (options[next]?.available) { optionRefs.current[next]?.focus(); return }
      next = (next + 1) % options.length
    }
  }
  const openMenu = () => {
    if (unavailable) return
    setOpen(true)
    const selected = Math.max(0, assistant.tiers.findIndex(item => item.id === assistant.tier))
    window.setTimeout(() => focusOption(selected), 0)
  }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(true)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const menuKeyDown = (event: KeyboardEvent) => {
    const current = optionRefs.current.findIndex(item => item === document.activeElement)
    if (event.key === 'Escape') { event.preventDefault(); close(true); return }
    if (event.key === 'Tab') { close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') { focusOption(0); return }
    if (event.key === 'End') {
      for (let index = assistant.tiers.length - 1; index >= 0; index -= 1) {
        if (assistant.tiers[index].available) { optionRefs.current[index]?.focus(); return }
      }
    }
    const direction = event.key === 'ArrowUp' ? -1 : 1
    let next = current < 0 ? 0 : current
    for (let attempts = 0; attempts < assistant.tiers.length; attempts += 1) {
      next = (next + direction + assistant.tiers.length) % assistant.tiers.length
      if (assistant.tiers[next].available) { optionRefs.current[next]?.focus(); return }
    }
  }

  return <div ref={rootRef} className={`tier-selector tier-selector-${context}`}
    data-selected-tier={assistant.tier}>
    <button ref={triggerRef} type="button" className="product-selector" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={`${id}-options`} disabled={unavailable} onClick={() => open ? close(true) : openMenu()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu() }
        if (event.key === 'Escape' && open) { event.preventDefault(); close(true) }
      }}>
      <span>{assistant.tier_label}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div id={`${id}-options`} className="tier-options" role="listbox" aria-label="Swico modes" onKeyDown={menuKeyDown}>
      {assistant.tiers.map((item, index) => <button key={item.id} ref={element => { optionRefs.current[index] = element }}
        type="button" role="option" data-tier-id={item.id}
        aria-selected={item.id === assistant.tier} disabled={!item.available || saving}
        onClick={() => {
          close(true)
          if (item.id !== assistant.tier) {
            void Promise.resolve(onSelect(item.id)).catch(() => undefined)
          }
        }}>
        <span><strong>{item.label}</strong><small>{item.description}</small></span>
        {item.id === assistant.tier && <Check size={16} aria-hidden="true" />}
        {!item.available && <em>Unavailable</em>}
      </button>)}
    </div>}
    {context === 'settings' && <p className="tier-current-description">{assistant.tier_description}</p>}
  </div>
}
