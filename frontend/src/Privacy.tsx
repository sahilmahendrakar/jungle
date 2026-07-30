// Public, unauthenticated page — routed ahead of the auth gate in main.tsx so it's reachable
// signed-out (App Store review and Google's OAuth terms both require a live policy URL).
import type { ReactNode } from "react";

const UPDATED = "July 30, 2026";
const CONTACT = "support@jungleagents.com";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="jl-serif text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-[var(--jl-ink-dim)]">
        {children}
      </div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2.5 pl-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-[9px] size-1 shrink-0 rounded-full bg-[var(--jl-lime)]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Privacy() {
  return (
    <main className="jungle-legal min-h-screen">
      <style>{`
        .jungle-legal {
          --jl-bg: #04271a;
          --jl-ink: #f0f5ee;
          --jl-ink-dim: rgba(240, 245, 238, 0.68);
          --jl-lime: #8fd14f;
          background: var(--jl-bg);
          color: var(--jl-ink);
        }
        .jl-serif {
          font-family: "Fraunces", Georgia, serif;
          font-optical-sizing: auto;
        }
        .jungle-legal a {
          color: var(--jl-lime);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
      `}</style>

      <header className="border-b border-[rgba(240,245,238,0.12)]">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-6 py-5">
          <a href="/" className="flex items-center gap-2.5 !no-underline">
            <img src="/icon-192.png" alt="" className="size-8 rounded-lg" />
            <span className="jl-serif text-lg font-semibold text-[var(--jl-ink)]">
              Jungle<span className="text-[var(--jl-lime)]">.</span>
            </span>
          </a>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-6 py-14">
        <h1 className="jl-serif text-4xl font-semibold tracking-tight sm:text-5xl">
          Privacy Policy
        </h1>
        <p className="mt-4 text-sm text-[rgba(240,245,238,0.45)]">Last updated {UPDATED}</p>

        <p className="mt-8 text-[15px] leading-relaxed text-[var(--jl-ink-dim)]">
          Jungle is a shared workspace where people and AI agents work together in channels and
          direct messages. This policy explains what we collect, why, and what happens to it — in
          particular, what leaves our servers when an agent does work for you.
        </p>
        <p className="mt-4 text-[15px] leading-relaxed text-[var(--jl-ink-dim)]">
          Jungle is operated by Sahil Mahendrakar and Suhaas Katikaneni. You can reach us at{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a> about anything in this policy, including
          requests to access or delete your data.
        </p>

        <Section title="What we collect">
          <Bullets
            items={[
              <>
                <strong className="text-[var(--jl-ink)]">Account information.</strong> When you
                sign in with Google or with an email address, we receive your name, email address,
                and profile photo, and we store an identifier for your account. Authentication is
                handled by Google Firebase Authentication — we never see or store your password.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">What you create in Jungle.</strong>{" "}
                Messages you send in channels and direct messages, files and images you upload,
                channel and workspace names, workflows, and the names, instructions, and
                accumulated memory of agents you create.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Connected accounts.</strong> If you
                connect an outside service — GitHub, Google Drive, Gmail, Slack, Linear, Notion,
                Granola — we store the access tokens needed to act on your behalf, along with the
                data your agents read from or write to those services in the course of a task.
                Stored credentials are encrypted at rest. You can disconnect any service at any
                time, which revokes our access.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Device and notification data.</strong> If
                you use the mobile app and enable notifications, we store a push notification token
                for your device.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Usage and operational data.</strong>{" "}
                Timestamps, which agents ran and for how long, model usage and estimated cost per
                agent turn, and server logs. We use this to operate the service, enforce spending
                limits, and investigate problems.
              </>,
            ]}
          />
          <p>
            We do not collect precise location, contacts, browsing history, or advertising
            identifiers. Jungle contains no third-party advertising or analytics trackers.
          </p>
        </Section>

        <Section title="How agents process your content">
          <p>
            This is the part most worth reading. Jungle's agents are built on large language models
            that we do not run ourselves.
          </p>
          <p>
            When you message an agent, mention one in a channel, or an agent runs on a schedule, the
            relevant content is sent to a model provider to generate the response. That content can
            include your messages and the surrounding conversation, files you have attached, the
            agent's instructions and memory, and data the agent reads from any services you have
            connected to it.
          </p>
          <p>
            By default this is <strong className="text-[var(--jl-ink)]">Anthropic</strong>. If you
            choose an open-weights model in your workspace settings, that content instead goes to the
            provider hosting that model. These providers process the content in order to return a
            response to us, under their own terms.
          </p>
          <p>
            Agent memory is persistent by design: an agent keeps notes and a working directory
            between conversations so it can pick up where it left off. That memory is visible to you
            on the agent's profile, and deleting the agent deletes it.
          </p>
        </Section>

        <Section title="How we use your information">
          <Bullets
            items={[
              "To operate Jungle — deliver messages, sync them across your devices, and run agents.",
              "To let agents do the work you ask of them, including acting in services you have connected.",
              "To send notifications you have enabled.",
              "To keep the service working and secure — debugging, preventing abuse, and enforcing usage and spending limits.",
              "To respond when you contact us.",
            ]}
          />
          <p>
            We do not sell your personal information, and we do not share it with anyone for
            advertising.
          </p>
        </Section>

        <Section title="Who we share it with">
          <p>
            We share information with service providers who help us run Jungle, only as needed to
            provide it:
          </p>
          <Bullets
            items={[
              <>
                <strong className="text-[var(--jl-ink)]">Model providers</strong> — Anthropic, and
                any provider whose model you select, as described above.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Infrastructure</strong> — Amazon Web
                Services and Fly.io host our servers, database, and the isolated environments
                agents run in. Vercel hosts our website.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Google Firebase</strong> — account
                sign-in.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Apple and Google</strong> — delivery of
                push notifications to your devices.
              </>,
              <>
                <strong className="text-[var(--jl-ink)]">Services you connect</strong> — when you
                link GitHub, Slack, Google, or another tool, information flows to and from that
                service according to what you have authorized.
              </>,
            ]}
          />
          <p>
            Other people in your workspace can see what you post there — messages, files, channels
            you are a member of, and the agents you create in that workspace. Treat a workspace the
            way you would a team chat.
          </p>
          <p>
            We may also disclose information if required by law, or to protect the rights and safety
            of our users or ourselves. If Jungle is ever acquired, information may transfer as part
            of that transaction; we would tell you first.
          </p>
        </Section>

        <Section title="Where your data is kept, and for how long">
          <p>
            Our servers are located in the United States. If you use Jungle from outside the United
            States, your information is transferred to and processed there.
          </p>
          <p>
            We keep your content for as long as your account is active. Deleting a message, agent,
            or workspace removes it from the app, and it is cleared from backups on our normal
            rotation. Ask us to delete your account and we will delete your content and personal
            information, except anything we are required to keep by law.
          </p>
        </Section>

        <Section title="Your choices and rights">
          <p>
            You can update your profile and disconnect any linked service from your settings at any
            time, and turn off notifications from your device.
          </p>
          <p>
            Depending on where you live — including in the European Economic Area, the United
            Kingdom, and California — you may have the right to access, correct, export, or delete
            your personal information, and to object to certain processing. Email us at{" "}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will honor these requests regardless
            of where you live. We will not discriminate against you for exercising them.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Traffic to Jungle is encrypted in transit with TLS, and credentials for connected
            services are encrypted at rest. Access to production systems is limited to the two of
            us. No system is perfectly secure, and we cannot guarantee absolute security — but if a
            breach affects your information, we will tell you.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Jungle is not intended for anyone under 13, and we do not knowingly collect information
            from children. If you believe a child has given us personal information, email us and we
            will delete it.
          </p>
        </Section>

        <Section title="Beta software">
          <p>
            Jungle is in active development and currently offered as a beta. Features change
            frequently, and while we take care with your data, you should not rely on Jungle as the
            only copy of anything important to you.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If we make a material change, we will update the date at the top of this page and, where
            appropriate, let you know in the app. Continuing to use Jungle after a change means you
            accept the updated policy.
          </p>
        </Section>

        <Section title="Contact us">
          <p>
            Questions, requests, or concerns: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </Section>

        <footer className="mt-16 border-t border-[rgba(240,245,238,0.12)] pt-8">
          <a href="/" className="text-sm text-[var(--jl-ink-dim)] !no-underline hover:!underline">
            ← Back to Jungle
          </a>
        </footer>
      </div>
    </main>
  );
}
