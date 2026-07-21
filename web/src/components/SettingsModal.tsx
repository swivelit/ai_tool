import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, CreditCard, Database, Settings2, UserRound, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { ApiError, ApiNetworkError, apiJson } from '../api/client'
import { formatRupeesFromPaise, fullTokenRangeLabel, tokenRangeLabel } from '../credits'
import type { AssistantSettings, MemorySettings, PaymentHistory, ProfileSettings, SwicoTier, UsagePreferences, UsageSummary } from '../types'
import type { Theme } from '../theme'
import { paymentPresentation } from '../billing/paymentPresentation'
import { SwicoTierSelector } from './SwicoTierSelector'

type Section = 'general' | 'profile' | 'usage' | 'data'
type Loaded = { profile: ProfileSettings; usage: UsageSummary; preferences: UsagePreferences; payments: PaymentHistory[]; memory: MemorySettings }

const sections: Array<{ id: Section; label: string; icon: typeof Settings2 }> = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'usage', label: 'Token credits', icon: CreditCard },
  { id: 'data', label: 'Data controls', icon: Database },
]

function safeError(error: unknown) {
  if (error instanceof ApiNetworkError) return 'You appear to be offline. Reconnect and try again.'
  if (error instanceof ApiError) return error.message
  return 'Settings could not be saved. Please try again.'
}

function UsageBars({ usage }: { usage: UsageSummary }) {
  const tiers = (['lite', 'standard', 'pro'] as const).map(id => {
    const item = usage.by_tier[id]
    return {
      id, label: item.label, credits: item.debited_token_credits,
      percent: item.utilization_percentage ?? (usage.monthly_hard_limit_micros !== null ? item.monthly_limit_percentage : item.period_debit_percentage),
      detail: `${item.request_count.toLocaleString()} requests · ${item.input_tokens.toLocaleString()} input · ${item.cached_input_tokens.toLocaleString()} cached · ${item.output_tokens.toLocaleString()} output · ${item.total_tokens.toLocaleString()} total tokens`, creditLabel: 'Chat credits',
      basis: item.utilization_basis ?? (usage.monthly_hard_limit_micros !== null ? 'monthly_hard_limit' : 'available_plus_period_debit'),
    }
  })
  const voice = usage.voice
  const items = [...tiers, {
    id: 'voice', label: voice.label, credits: voice.debited_voice_credits,
    percent: voice.utilization_percentage ?? (usage.monthly_hard_limit_micros !== null ? voice.monthly_limit_percentage : voice.period_debit_percentage),
    detail: `${voice.stt_request_count.toLocaleString()} STT requests · ${voice.llm_request_count.toLocaleString()} AI response requests · ${voice.tts_request_count.toLocaleString()} TTS requests · ${voice.llm_input_tokens.toLocaleString()} AI input · ${voice.llm_cached_input_tokens.toLocaleString()} cached · ${voice.llm_output_tokens.toLocaleString()} AI output · ${voice.llm_total_tokens.toLocaleString()} AI total tokens · ${voice.total_audio_seconds.toLocaleString()} STT seconds · ${voice.total_tts_characters.toLocaleString()} TTS characters`,
    creditLabel: 'Voice credits',
    basis: voice.utilization_basis ?? (usage.monthly_hard_limit_micros !== null ? 'monthly_hard_limit' : 'available_plus_period_debit'),
  }]
  return <div className="usage-breakdowns" aria-label="Usage by category">
    {items.map(item => {
      const value = Math.min(100, Math.max(0, item.percent))
      return <article key={item.id} className="usage-breakdown">
        <div><strong>{item.label}</strong><span>{item.credits} {item.creditLabel}</span></div>
        <div className="usage-progress" role="progressbar" aria-label={`${item.label} credit utilization`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.billing_exempt ? undefined : value} aria-valuetext={usage.billing_exempt ? 'Unlimited' : `${value}% utilization; ${item.credits} ${item.creditLabel} used`}>
          <span style={{ width: `${value}%` }} />
        </div>
        <small>{usage.billing_exempt ? 'Unlimited' : `${value}% · ${item.credits} exact credits · ${item.basis === 'monthly_hard_limit' ? 'monthly limit' : 'available balance plus period debit'}`}</small>
        <small>{item.detail}{Number(item.credits) === 0 ? ' · No usage yet' : ''}</small>
      </article>
    })}
  </div>
}

export function SettingsModal({ user, theme, setTheme, assistant, tierSaving, saveTier, close, addCredits, openArchived, savedProfile }: {
  user: User; theme: Theme; setTheme: (theme: Theme) => void; close: () => void;
  assistant: AssistantSettings; tierSaving: boolean; saveTier: (tier: SwicoTier) => Promise<void>;
  addCredits: () => void; openArchived: () => void; savedProfile: (profile: ProfileSettings) => void;
}) {
  const [section, setSection] = useState<Section>('general')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState<ProfileSettings | null>(null)
  const [cap, setCap] = useState('')
  const [unlimited, setUnlimited] = useState(true)
  const [warning, setWarning] = useState('80')
  const [notify, setNotify] = useState(true)
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null)

  const load = async () => {
    if (!navigator.onLine) { setLoadError('You’re offline. Reconnect to load settings.'); return }
    setLoadError('')
    try {
      const [nextProfile, usage, preferences, payments] = await Promise.all([
        apiJson<ProfileSettings>(user, '/api/web/settings/profile'),
        apiJson<UsageSummary>(user, '/api/web/usage/summary?period=current_month'),
        apiJson<UsagePreferences>(user, '/api/web/settings/usage'),
        apiJson<{ items: PaymentHistory[] }>(user, '/api/web/billing/payments'),
      ])
      const memory = await apiJson<MemorySettings>(user, '/api/web/settings/memory')
        .catch(() => ({ available: false, enabled: false, items: [] }))
      setLoaded({ profile: nextProfile, usage, preferences, payments: payments.items, memory })
      setProfile(nextProfile)
      setUnlimited(preferences.hard_limit_micros === null)
      setCap(preferences.hard_limit_token_estimate?.estimated_blended_tokens?.toString() ?? '')
      setWarning(String(preferences.warning_threshold_percent)); setNotify(preferences.notify_at_threshold)
    } catch (error) { setLoadError(safeError(error)) }
  }
  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    closeRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]; const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => window.removeEventListener('keydown', keyboard, true)
  }, [close, saving])

  const estimate = loaded?.usage.estimated_tokens_remaining
  const billingExempt = loaded?.usage.billing_exempt === true
  const tokenRange = useMemo(() => estimate ? fullTokenRangeLabel(estimate.range_min_tokens, estimate.range_max_tokens) : 'Estimate unavailable', [estimate])
  const saveProfile = async () => {
    if (!profile) return
    if (!profile.name.trim() || !profile.assistant_name.trim() || !profile.timezone.trim()) { setNotice('Name, timezone, and assistant name are required.'); return }
    setSaving(true); setNotice('')
    try {
      const next = await apiJson<ProfileSettings>(user, '/api/web/settings/profile', { method: 'PATCH', body: JSON.stringify({
        name: profile.name, place: profile.place, timezone: profile.timezone,
        assistant_name: profile.assistant_name, reply_language: profile.reply_language,
      }) })
      setProfile(next); savedProfile(next); setNotice('Profile saved.')
    } catch (error) { setNotice(safeError(error)) } finally { setSaving(false) }
  }
  const saveUsage = async () => {
    const limit = unlimited ? null : Number(cap)
    const threshold = Number(warning)
    if (!unlimited && (!Number.isSafeInteger(limit) || Number(limit) <= 0)) { setNotice('Enter a positive whole-number estimated token limit.'); return }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) { setNotice('Warning threshold must be from 1 to 100%.'); return }
    setSaving(true); setNotice('')
    try {
      const preferences = await apiJson<UsagePreferences>(user, '/api/web/settings/usage', { method: 'PATCH', body: JSON.stringify({
        period: 'monthly', hard_limit_estimated_tokens: limit, warning_threshold_percent: threshold,
        notify_at_threshold: notify,
      }) })
      setLoaded(value => value ? { ...value, preferences } : value); setNotice('Monthly usage limit saved.')
    } catch (error) { setNotice(safeError(error)) } finally { setSaving(false) }
  }
  const changeTier = async (tier: SwicoTier) => {
    setNotice('')
    try {
      await saveTier(tier)
      await load()
      setNotice('Swico mode saved. New messages will use this mode.')
    } catch {
      setNotice('Swico mode could not be changed. Your previous mode is still active.')
    }
  }
  const setMemoryEnabled = async (enabled: boolean) => {
    setSaving(true); setNotice('')
    try {
      const memory = await apiJson<MemorySettings>(user, '/api/web/settings/memory', {
        method: 'PATCH', body: JSON.stringify({ enabled }),
      })
      setLoaded(value => value ? { ...value, memory } : value)
      setNotice(enabled ? 'Cross-chat memory enabled.' : 'Cross-chat memory disabled. No new memory will be saved or retrieved.')
    } catch (error) { setNotice(safeError(error)) } finally { setSaving(false) }
  }
  const deleteMemory = async (memoryId?: string) => {
    if (!window.confirm(memoryId ? 'Delete this saved memory?' : 'Clear all saved cross-chat memory?')) return
    setSaving(true); setNotice('')
    try {
      await apiJson<unknown>(user, memoryId ? `/api/web/settings/memory/${memoryId}` : '/api/web/settings/memory', { method: 'DELETE' })
      const memory = await apiJson<MemorySettings>(user, '/api/web/settings/memory')
      setLoaded(value => value ? { ...value, memory } : value); setNotice(memoryId ? 'Saved memory deleted.' : 'All cross-chat memory cleared.')
    } catch (error) { setNotice(safeError(error)) } finally { setSaving(false) }
  }

  return <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) close() }}>
    <section ref={dialogRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-heading"><h2 id="settings-title">Settings</h2><button ref={closeRef} className="icon-button" aria-label="Close settings" onClick={close} disabled={saving}><X size={20} /></button></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">{sections.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => { setSection(item.id); setNotice('') }}><Icon size={17} /><span>{item.label}</span></button> })}</nav>
        <div className="settings-content">
          {loadError && <div className="settings-state" role="alert"><p>{loadError}</p><button onClick={() => void load()}>Retry</button></div>}
          {!loadError && !loaded && <div className="settings-state" role="status">Loading settings…</div>}
          {loaded && section === 'general' && <section aria-labelledby="general-settings"><h3 id="general-settings">General</h3><div className="general-tier-setting"><h4>Swico mode</h4><SwicoTierSelector assistant={assistant} saving={tierSaving} disabled={tierSaving} onSelect={changeTier} context="settings" /><small>Mode changes apply to your next message.</small></div><label>Theme<select value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Interface language<select value="en" disabled aria-describedby="interface-language-help"><option value="en">English</option></select><small id="interface-language-help">Tamil replies are available in Profile. The settings interface currently supports English.</small></label></section>}
          {loaded && section === 'profile' && profile && <section aria-labelledby="profile-settings"><h3 id="profile-settings">Profile</h3><div className="settings-form-grid">
            <label>Name<input value={profile.name} maxLength={80} onChange={event => setProfile({ ...profile, name: event.target.value })} /></label>
            <label>Place<input value={profile.place ?? ''} maxLength={120} onChange={event => setProfile({ ...profile, place: event.target.value || null })} /></label>
            <label>Timezone<input list="timezone-options" value={profile.timezone} maxLength={64} onChange={event => setProfile({ ...profile, timezone: event.target.value })} /><datalist id="timezone-options"><option value="Asia/Kolkata" /><option value="Europe/London" /><option value="America/New_York" /></datalist></label>
            <label>Assistant name<input value={profile.assistant_name} maxLength={40} onChange={event => setProfile({ ...profile, assistant_name: event.target.value })} /></label>
            <label htmlFor="profile-reply-language">Reply language<select id="profile-reply-language" value={profile.reply_language} onChange={event => setProfile({ ...profile, reply_language: event.target.value as 'en' | 'ta' })}><option value="en">English</option><option value="ta">தமிழ் (Tamil)</option></select></label>
            <label>Email<input value={profile.email ?? ''} readOnly aria-describedby="email-readonly" /><small id="email-readonly">Email is managed by your sign-in account and cannot be changed here.</small></label>
          </div><button className="primary" disabled={saving} onClick={() => void saveProfile()}>{saving ? 'Saving…' : 'Save profile'}</button></section>}
          {loaded && section === 'usage' && <section aria-labelledby="usage-settings"><h3 id="usage-settings">Token credits</h3>
            <div className="usage-cards"><article><span>Chat credits available</span><strong>{billingExempt ? 'Unlimited' : loaded.usage.chat_available_credits ?? loaded.usage.available_ai_credits}</strong></article><article><span>Voice credits available</span><strong>{billingExempt ? 'Unlimited' : loaded.usage.voice_available_credits ?? '0.000000'}</strong></article>{!billingExempt && <article><span>{loaded.usage.tier_label} estimated token range</span><strong>{tokenRange}</strong></article>}</div>
            <UsageBars usage={loaded.usage} />
            <div className="actual-usage" aria-label="This month token usage"><h4>This month</h4><dl><div><dt>Input tokens</dt><dd>{loaded.usage.input_tokens.toLocaleString()}</dd></div><div><dt>Cached input tokens</dt><dd>{loaded.usage.cached_input_tokens.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{loaded.usage.output_tokens.toLocaleString()}</dd></div><div><dt>Total tokens</dt><dd>{loaded.usage.total_tokens.toLocaleString()}</dd></div></dl></div>
            <p className="usage-note">Chat and Voice are separate prepaid balances. Realtime Voice uses Voice credits for transcription, AI response generation, and speech. Dictation transcription uses Voice credits; sending its draft as normal Chat uses Chat credits.</p>
            {!billingExempt && <fieldset className="usage-limit"><legend>Estimated monthly token limit</legend><label className="check-row"><input type="checkbox" checked={unlimited} onChange={event => setUnlimited(event.target.checked)} />No monthly limit beyond prepaid token credits</label>{!unlimited && <label>Estimated monthly tokens<input inputMode="numeric" pattern="[0-9]*" value={cap} onChange={event => setCap(event.target.value)} aria-describedby="cap-help" /><small id="cap-help">Converted by the server to the existing monetary hard limit using your selected Swico mode. Actual usage varies; automatic recharge is not enabled.</small></label>}<label>Warning threshold (%)<input type="number" min="1" max="100" value={warning} onChange={event => setWarning(event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} />Show a warning at the threshold</label>{loaded.preferences.warning_reached && <p className="usage-warning" role="status">You have reached your configured warning threshold.</p>}<button className="primary" disabled={saving} onClick={() => void saveUsage()}>{saving ? 'Saving…' : 'Save usage limit'}</button><small>Resets {new Date(loaded.preferences.next_reset_at).toLocaleString()} ({loaded.preferences.timezone}).</small></fieldset>}
            {!billingExempt && <button className="secondary-button" onClick={addCredits}>Add credits</button>}
            <div className="settings-history"><h4>Payment history</h4>{!loaded.payments.length ? <p>No payments or refunds yet.</p> : loaded.payments.map(payment => { const presentation = paymentPresentation(payment); const paymentBucket = payment.credit_bucket ?? 'chat'; return <article key={payment.id}><strong>{presentation.heading}</strong><span>{paymentBucket === 'voice' ? 'Voice credits' : 'Chat credits'}</span>{presentation.detail && <span>{presentation.detail}</span>}{presentation.amountLabel && <span>{presentation.amountLabel}: {formatRupeesFromPaise(payment.gross_amount_paise)}</span>}{presentation.showTokensAdded && paymentBucket === 'chat' && <span>Estimated {payment.token_estimate ? tokenRangeLabel(payment.token_estimate.range_min_tokens, payment.token_estimate.range_max_tokens) : 'tokens unavailable'} added</span>}{presentation.showTokensAdded && paymentBucket === 'voice' && <span>{payment.voice_estimate ? `${payment.voice_estimate.estimated_stt_minutes} STT-only minutes or ${payment.voice_estimate.estimated_tts_characters.toLocaleString()} TTS-only characters; component-only estimates. Realtime Voice also uses Voice credits for AI response generation.` : 'Voice estimate unavailable'}</span>}{presentation.showRefundAmount && <span>{formatRupeesFromPaise(payment.refunded_amount_paise)} refunded</span>}{presentation.showReversalEstimate && <span>Estimated {payment.reversal_token_estimate ? tokenRangeLabel(payment.reversal_token_estimate.range_min_tokens, payment.reversal_token_estimate.range_max_tokens) : 'credits unavailable'} reversed</span>}<span>{presentation.timestampLabel} <time dateTime={presentation.timestamp}>{new Date(presentation.timestamp).toLocaleDateString()}</time></span></article> })}</div>
          </section>}
          {loaded && section === 'data' && <section aria-labelledby="data-settings"><h3 id="data-settings">Data controls</h3><button className="data-control" onClick={openArchived}><Archive size={18} /><span><strong>Archived chats</strong><small>Review or restore conversations you archived.</small></span></button>
            <div className="memory-controls"><h4>Cross-chat memory</h4>{loaded.memory.available ? <><label className="check-row"><input type="checkbox" checked={loaded.memory.enabled} disabled={saving} onChange={event => void setMemoryEnabled(event.target.checked)} />Use relevant saved details in other chats</label><small>Only explicit preferences, ongoing projects, and deterministic conversation summaries are saved. No LLM is called to manage memory.</small>
              <div className="memory-list">{!loaded.memory.items.length ? <p>No saved memory facts.</p> : loaded.memory.items.map(item => <article key={item.id}><span><strong>{item.category.replaceAll('_', ' ')}</strong><small>{item.value_text}</small></span><button type="button" disabled={saving} aria-label={`Delete memory ${item.value_text}`} onClick={() => void deleteMemory(item.id)}>Delete</button></article>)}</div>
              {loaded.memory.items.length > 0 && <button className="danger-button" type="button" disabled={saving} onClick={() => void deleteMemory()}>Clear all memory</button>}</> : <p>Cross-chat memory is not enabled on this deployment.</p>}</div>
            <div className="settings-legal"><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/refunds">Refund and cancellation</a><a href="/legal/contact">Contact and support</a><a href="/legal/ai">AI limitations</a><a href="/legal/delivery">Digital delivery</a><a href="/legal/pricing">Pricing and top-ups</a></div><p className="data-note">Account deletion is not offered here because secure reauthentication and server-side deletion are not implemented.</p></section>}
          <div className="sr-status" role="status" aria-live="polite">{notice}</div>{notice && <p className="settings-notice" aria-hidden="true">{notice}</p>}
        </div>
      </div>
    </section>
  </div>
}
