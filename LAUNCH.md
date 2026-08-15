# LAUNCH

Ready-to-post copy for the founding-access launch. Nothing here is auto-sent —
paste what you want, where you want.

Live surfaces:

- Landing + pricing — https://foundry-site-ye1g.onrender.com/#pricing
- Operator console — https://foundry-site-ye1g.onrender.com/console.html
- Checkout — one customer-chooses-price Stripe Payment Link, tier tagged via
  `client_reference_id` and confirmed by signed webhook.

Ladder to $1,000: 10 × $99, or 4 × $299, or any mix. Backer tier exists to
convert people who won't spend $99 but will spend $25.

---

## The angle

Do not lead with "autonomous AI company." Everyone is saying that and nobody
believes it. Lead with the thing nobody else can claim:

> **It refuses to lie about itself.**

The status board says NOT COMPLETE, in public, because a probe says so. That is
the product. Every competitor demo is a video of a happy path; this one ships
its own failures on the marketing page. That asymmetry is the whole pitch.

---

## X / Twitter

**Post 1 — the hook**

> I built an AI system that runs a company end to end.
>
> The landing page says NOT COMPLETE.
>
> Not because I ran out of time — because the code physically cannot claim an
> integration works until a dated live probe says it does. 78 agents, and none
> of them can mark their own homework.
>
> [link]

**Post 2 — the detail that earns the reply**

> The rule that shaped every line of it:
>
> Nothing may assert that an integration works. It may only ask the capability
> registry, and the registry returns live_verified only if (a) the secret exists
> and is well-formed and (b) a dated row records a successful live probe.
>
> One service is the only writer of that row.

**Post 3 — the close**

> Missing credentials are a correct state, not a bug. A provider with no key
> reports blocked_missing_credentials with remediation text, and the rest of the
> system stays testable.
>
> Founding access is $99 while I finish it: [link]

## Hacker News (Show HN)

**Title:** Show HN: An agent company factory whose landing page admits it isn't done

**Body:**

> The interesting constraint isn't the agents, it's the honesty enforcement.
>
> A 13-member error category union drives retry and HTTP status mechanically.
> Money is a frozen bigint minor-units class that refuses to truncate precision
> or mix currencies. Audit events are append-only and hash-chained — a trigger
> refuses UPDATE and DELETE. Chain of command is enforced in code, not in the
> prompt: a specialist that tries to delegate gets a PolicyDeniedError, because
> the org chart is the authority model.
>
> The part I'd defend hardest: a missing API key is a first-class state. It
> returns blocked, not an exception, because throwing means "retry me" and
> retrying a job that waits on an unissued key just burns the retry budget.
>
> It is not finished. The status page says so and the test suite fails if the
> copy overstates readiness.

## Reddit — r/SideProject, r/indiehackers

Same angle, softer. Lead with the counterintuitive bit: *"I made my own landing
page call my project incomplete, and it's the reason people are buying."*

## Direct outreach (highest conversion per message)

Cheapest path to $1,000 is 4 people who already know you paying $299. Message
individually, never as a blast:

> Building an operating layer that runs a company through an agent org — 78
> roles, policy-gated spend, hash-chained audit trail. It's not finished and the
> site says so.
>
> Founding access is $99, or $299 if you want me to stand it up on your Render
> account with your keys. Would that be useful to you, or do you know someone
> it'd be useful to?

---

## Before you post

- [ ] `ANTHROPIC_API_KEY` set on `foundry-worker` and `foundry-api` — the loop
      cannot run without it, and "the loop ran" is the demo.
- [ ] Click each of the three tier buttons yourself and confirm Stripe loads.
- [ ] Watch `checkout.session.completed` land with `client_reference_id` on the
      first real sale, so attribution is proven rather than assumed.
