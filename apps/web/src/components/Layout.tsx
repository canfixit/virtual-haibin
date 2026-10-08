import type { ReactNode } from "react";

export function Header() {
  return (
    <header className="site-header">
      <div className="container header-row">
        <a className="wordmark" href="#top" aria-label="CanFixIT — Virtual Haibin">
          <span className="wordmark-company">CanFixIT</span>
          <span className="wordmark-divider" aria-hidden="true">
            |
          </span>
          <span className="wordmark-product">Virtual Haibin</span>
        </a>
        <nav className="site-nav" aria-label="Sections">
          <a href="#demo">Demo</a>
          <a href="#how">How it works</a>
          <a href="#evidence">Evidence</a>
          <a href="#details">Technical details</a>
        </nav>
        <span className="env-badge" title="Pay.sh Solana Payment Sandbox: a hosted test validator. No real funds.">
          <span className="env-dot" aria-hidden="true" />
          Solana payment sandbox · no real funds
        </span>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="container hero-grid">
        <div>
          <p className="eyebrow">Verifiable spending permissions for AI agents</p>
          <h1>Human-authorized spending for AI agents</h1>
          <p className="hero-lede">
            Virtual Haibin checks what a human actually authorized before an AI agent can pay for a protected API operation.
          </p>
          <div className="hero-actions">
            <a className="button button-purple" href="#demo">
              Start demo
            </a>
            <a className="button button-ghost-inverse" href="#how">
              How it works
            </a>
          </div>
        </div>
        <ol className="hero-statement" aria-label="The idea in three lines">
          <li className="statement-same">
            <span className="statement-key">Same</span> payment.
          </li>
          <li className="statement-different">
            <span className="statement-key">Different</span> operation.
          </li>
          <li className="statement-decision">
            <span className="statement-key">Different</span> decision.
          </li>
        </ol>
      </div>
    </section>
  );
}

export function Section(props: { id: string; step?: string; title: string; lede?: ReactNode; children: ReactNode; tone?: "blue" | "red" | "purple" | "neutral" }) {
  return (
    <section className={`section tone-${props.tone ?? "neutral"}`} id={props.id} aria-labelledby={`${props.id}-title`}>
      <div className="container">
        <header className="section-header">
          {props.step && <span className="section-step">{props.step}</span>}
          <h2 id={`${props.id}-title`}>{props.title}</h2>
          {props.lede && <p className="section-lede">{props.lede}</p>}
        </header>
        {props.children}
      </div>
    </section>
  );
}

export function Field(props: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="field">
      <dt>{props.label}</dt>
      <dd className={props.mono ? "mono" : undefined}>{props.children}</dd>
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? (
    <p className="error-note" role="alert">
      {message}
    </p>
  ) : null;
}
