import { Check, Copy, Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useClipboardFeedback } from '../components/useClipboardFeedback'

function CommandBlock({ value, label = 'Copy command' }: { value: string; label?: string }) {
  const { copy, copyState } = useClipboardFeedback(value)
  const buttonLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : label
  return <div className="cli-command-block">
    <pre><code>{value}</code></pre>
    <button type="button" className="cli-copy-button" aria-label={buttonLabel} title={buttonLabel} onClick={() => void copy()}>
      {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
      <span>{buttonLabel}</span>
    </button>
    <span className="sr-only" role="status" aria-live="polite">{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : ''}</span>
  </div>
}

function GuideSection({ id, number, title, children }: { id: string; number: string; title: string; children: ReactNode }) {
  return <section className="cli-guide-section" id={id}>
    <div className="cli-guide-section-number">{number}</div>
    <div><h2>{title}</h2>{children}</div>
  </section>
}

export function CliGuidePage({ isAuthenticated = false }: { isAuthenticated?: boolean }) {
  return <main className="cli-guide-page">
    <header className="cli-guide-header">
      <Link className="cli-guide-brand" to="/" aria-label="Back to Swico home"><span className="brand-mark" aria-hidden="true">S</span><span><strong>Swico CLI</strong><small>Terminal Chat</small></span></Link>
      <nav aria-label="Guide navigation"><Link to="/">Back to Swico</Link>{isAuthenticated ? <Link className="cli-guide-sign-in" to="/">Open Swico</Link> : <Link className="cli-guide-sign-in" to="/login?returnTo=%2Fswico-cli">Sign in</Link>}</nav>
    </header>

    <div className="cli-guide-layout">
      <aside className="cli-guide-contents" aria-label="Swico CLI guide sections">
        <span>On this page</span>
        <a href="#get-started">Get started</a><a href="#install">Install</a><a href="#activate">Sign in</a><a href="#start">Start Swico</a><a href="#commands">Commands</a><a href="#update">Update</a><a href="#reinstall">Reinstall</a><a href="#uninstall">Uninstall</a><a href="#completion">Shell completion</a><a href="#troubleshooting">Troubleshooting</a><a href="#security">Security</a><a href="#limitation">Current limitation</a>
      </aside>
      <article className="cli-guide-content">
        <div className="cli-guide-hero">
          <span className="cli-guide-kicker"><Terminal size={16} /> Swico for your terminal</span>
          <h1>Swico CLI</h1>
          <p>Use Swico directly from your terminal.</p>
          <CommandBlock value="npm install -g @swiveltechnologies/swico" />
          <small>Requires Node.js 20 or newer.</small>
        </div>

        <GuideSection id="get-started" number="01" title="Get started">
          <p>Swico CLI runs on Node.js 20 or newer. You do not need Python, this Git repository, provider or API keys, or an npm account merely to install the public package.</p>
          <CommandBlock value={'node --version\nnpm --version'} />
        </GuideSection>

        <GuideSection id="install" number="02" title="Install">
          <p>Install the stable public package globally, then confirm the executable and build identity.</p>
          <CommandBlock value={'npm install -g @swiveltechnologies/swico\nswico --version --json'} />
        </GuideSection>

        <GuideSection id="activate" number="03" title="Sign in / activate">
          <p>Swico CLI uses your existing Swico account. It currently requires an eligible paid Chat tier. The browser approval keeps the terminal session connected to your account.</p>
          <CommandBlock value="swico login --tier lite" />
          <p className="cli-guide-muted">Other paid tiers are explicit alternatives:</p>
          <CommandBlock value={'swico login --tier standard\nswico login --tier pro'} />
          <ul><li>A browser opens to swico.in.</li><li>Sign in and approve the terminal.</li><li>Credentials use the OS secure credential store when available.</li></ul>
        </GuideSection>

        <GuideSection id="start" number="04" title="Start Swico">
          <p>Bare <code>swico</code> opens the interactive terminal UI. For a single request, use the explicit ask command.</p>
          <CommandBlock value={'swico\nswico ask "What can you help me with?"'} />
        </GuideSection>

        <GuideSection id="commands" number="05" title="Common commands">
          <p>These commands run at your shell:</p>
          <CommandBlock value={'swico\nswico --help\nswico --version --json\nswico whoami\nswico doctor\nswico usage\nswico usage --json\nswico logout'} />
          <p>Inside the interactive Swico terminal, use:</p>
          <CommandBlock value={'/usage\n/help\n/exit'} />
          <p className="cli-guide-callout"><strong>Shell or Swico?</strong> A command beginning with <code>/</code> belongs inside Swico. Do not type <code>/usage</code> at zsh, bash, or PowerShell.</p>
        </GuideSection>

        <GuideSection id="update" number="06" title="Update Swico">
          <p>Update deterministically to the latest stable package, then verify the installed identity.</p>
          <CommandBlock value={'npm install -g @swiveltechnologies/swico@latest\nswico --version --json'} />
          <p>To view the current stable version published to npm:</p>
          <CommandBlock value="npm view @swiveltechnologies/swico version" />
        </GuideSection>

        <GuideSection id="reinstall" number="07" title="Reinstall / fix installation">
          <p>Reinstall the package if the global executable is missing or stale. This does not revoke your Swico account or terminal sessions.</p>
          <CommandBlock value={'npm uninstall -g @swiveltechnologies/swico\nnpm install -g @swiveltechnologies/swico'} />
        </GuideSection>

        <GuideSection id="uninstall" number="08" title="Uninstall">
          <CommandBlock value="npm uninstall -g @swiveltechnologies/swico" />
          <p>Uninstalling removes the local package only. To revoke a terminal session, use <strong>Settings → Data controls → Terminal sessions</strong> on swico.in.</p>
        </GuideSection>

        <GuideSection id="completion" number="09" title="Shell completion">
          <p>Swico can print completion definitions for supported shells:</p>
          <CommandBlock value={'swico completion bash\nswico completion zsh\nswico completion fish\nswico completion powershell'} />
          <p>Follow the instructions printed by the command for your shell.</p>
        </GuideSection>

        <GuideSection id="troubleshooting" number="10" title="Troubleshooting">
          <h3>“swico: command not found”</h3>
          <p>Check Node.js and npm, reopen your terminal after a global install, and inspect the global npm location if needed.</p>
          <CommandBlock value={'node --version\nnpm --version\nnpm prefix -g\nnpm root -g'} />
          <p>Once the executable is available, <code>swico doctor</code> gives a safe local diagnosis.</p>
          <h3>Unsupported or old Node.js</h3>
          <p>Run <code>node --version</code> and upgrade to Node.js 20 or newer.</p>
          <h3>Windows</h3>
          <p>PowerShell users can run the same install and start commands. Windows may expose the generated <code>npm.cmd</code> or <code>swico.cmd</code> shim when command resolution requires it; the suffix is not normally needed when the PATH is configured.</p>
        </GuideSection>

        <GuideSection id="security" number="11" title="Security and privacy">
          <ul><li>Sign in through swico.in and approve the terminal in your browser.</li><li>No provider keys are required.</li><li>The server controls public tier access and routing.</li><li>Local credentials use OS secure storage where available.</li><li>Terminal sessions can be reviewed and revoked from the website.</li></ul>
        </GuideSection>

        <GuideSection id="limitation" number="12" title="Current limitation">
          <p>This guide covers the stable paid Chat CLI. The local coding agent and cloud execution are not enabled for production use, so Swico CLI should not be treated as a full Codex-equivalent coding environment.</p>
        </GuideSection>
      </article>
    </div>
  </main>
}
