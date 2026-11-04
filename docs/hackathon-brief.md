# PayPal AI Hackathon: full brief

Compiled 2026-10-27 from the Devpost site (overview, Rules, Schedule, FAQs, Resources, Updates, all ten sponsor pages, the three update posts) and from the PayPal and sponsor links those pages point to. Items from outside the Devpost site are marked **[linked]**. The strategy-side reading of these facts (what to build, how to score) is in [_strategy/01-research-report.md](../_strategy/01-research-report.md) and [_strategy/03-judging-playbook.md](../_strategy/03-judging-playbook.md). This file is the factual reference. Where the Official Rules and the overview differ, the Rules prevail (Rules s.11).

Hackathon: <https://paypalaihackathon.devpost.com/> · Title: "Build What's Next with PayPal and AI" · Devpost challenge id 31302 · Managed by Devpost, sponsored by PayPal Inc.

## 1. What it is

A global online hackathon with **no prescribed problem statements and no tracks**. The one fundamental requirement: the project must **meaningfully use both PayPal and AI**. Anything qualifies: an agent, app, automation, payment experience, business tool, social product. Solo, team or organisation entries are allowed; no team-size cap. New projects, or existing ones **significantly updated during the submission period** (explain how in the write-up).

Registered participants: **22,116** (2026-10-27; it was 15,287 on 2026-10-16). Registrations are not submissions. The project gallery is still unpublished.

## 2. Dates

| Phase | Start | End |
|---|---|---|
| Submissions | Thu Oct 1, 2026 9:15 am PT | **Thu Nov 12, 2026 12:00 pm PT** (= Fri Nov 13, 01:30 IST) |
| Judging | Tue Dec 1, 2026 2:00 pm PT | Tue Dec 15, 2026 8:00 am PT |
| Winners announced | on or around Mon Dec 21, 2026 | |

Discrepancy to know about: the Schedule page says winners at **9:00 am PST**, the Rules say **2:00 pm PT**. Treat "Dec 21" as the date and the time as unreliable. After the deadline a submission cannot be edited, except for permitted take-downs of infringing or personal data (Rules s.5).

Webinars (all recorded):

| When | Title | Link |
|---|---|---|
| Oct 6, 9:00-9:45 am PT | Start building with PayPal (Jo Franchetti, Marco Podien, Eddie Jaoude). Covers rules, prizes, AI Toolkit, sandbox setup. Chapters in the description | <https://www.youtube.com/watch?v=FFJfCW9z3Do> (short link <https://bit.ly/paypalai26recue>) |
| Oct 7, 9:00-9:30 am PT | Power your PayPal hackathon project with APIMatic Context Plugins | <https://youtu.be/zRWixN68tDg> |
| Oct 12, 7:00-7:45 am PT | Build a payments dashboard without building a dashboard (AG Grid) | <https://www.youtube.com/watch?v=LGfG44i1Fj8> |
| Oct 13, 1:00-2:00 am PT | Start building with PayPal (repeat session) | <https://youtu.be/ck_zyB66p_Y> |

## 3. Eligibility (Rules s.3)

Open to: individuals at the age of majority where they live, teams of them, and existing organisations. A person may be on several teams and also enter alone. One **Representative** submits for a team and receives the prize.

Not open to: residents or organisations in places where US or local law prohibits taking part or receiving a prize, **including Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea** and any OFAC comprehensively sanctioned country (applies to every team member); Sponsor and Administrator, their employees, agents and immediate family or household; **any judge and the company or person employing a judge**; affiliates of those; anyone creating a real or apparent conflict of interest. India is not excluded. Being able to open a PayPal sandbox account is a separate question from eligibility (FAQ).

## 4. What to build (Rules s.4)

Build or update an application that integrates the **PayPal developer platform using the free sandbox** plus an **AI tool, model or platform of your choice**. "PayPal" includes Venmo, Braintree, Xoom, Honey, Zettle, Paidy, Hyperwallet, Simility, Swift Financial and others. The project must:

- meaningfully integrate at least one PayPal technology, API, SDK, product or developer capability;
- meaningfully incorporate AI;
- be a working prototype or proof of concept;
- be documented enough for judges to evaluate;
- comply with the Official Rules.

Third-party SDKs, APIs and data need an authorisation or licence that permits your use. Work with a PayPal-funded or PayPal-contracted origin is disqualifying ("Financial or Preferential Support").

Sponsor tools are optional: AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman, Render, Zapier. Any AI tool works as long as PayPal is central.

## 5. What to submit

| Item | Requirement |
|---|---|
| Project | Meets s.4. Must install and run consistently and behave as the video and text say |
| Text description | Features and functionality. Explain what was significantly updated if the project pre-existed |
| Tools | Name the models and AI services used and how |
| Functional demo | Judges must be able to run or use a working build: **a hosted URL or complete run instructions in the repo**. Mockups, static prototypes and non-functional demos do not count |
| Public repo | GitHub, GitLab or Bitbucket. All source, assets and instructions. **Open-source licence file, visible in the About box** |
| Demo video | **Under 3 minutes** (judges need not watch longer). Shows the project working on its target device. **Public on YouTube**, link on the form. No third-party trademarks or copyrighted music or material without permission |
| Language | English, or provide an English translation of video, text and instructions |
| Testing access | Free and unrestricted for Sponsor, Administrator and judges **until the judging period ends** (Dec 15). A private site needs login credentials in the instructions. Put test accounts, keys and sandbox logins in the README |
| Hardware | If the software runs on proprietary or unusual hardware, the organisers may demand physical access |
| Ownership | Original work, solely owned, no third-party IP violations. Open-source use is fine if you build on it and follow its licence |
| Multiple entries | Allowed if each is unique and substantially different |

Entrants keep their IP and grant PayPal a non-exclusive licence for judging. PayPal and Devpost may use the submission, names, likenesses and voices to promote the hackathon for the hackathon period plus **three years** (s.7, s.10).

## 6. Judging (Rules s.6)

Judges: PayPal Jo Franchetti, Eddie Jaoude, Marco Podien (developer advocates), Karthik Ravi (software engineer), Himraj Singh (engineering manager), Nathaniel Olson (senior product manager); AG Grid Sylwia Vargas; APIMatic Ameer Hassan; Bryntum Mats Bryntse; Channel3 Ignacio Valdez Bicard; Elastic Carly Richmond; Postman Pooja Mistry; Render Shifra Williams. The panel can change, and judges may include unlisted people.

- **Stage 1, pass/fail:** reasonably fits the theme and reasonably applies the required APIs and SDKs.
- **Stage 2, five equally weighted criteria:**
  1. **Technological Implementation:** how thoroughly and skilfully PayPal and AI are used; genuine, working, non-trivial.
  2. **Design:** a complete, coherent product experience, not just a proof of concept.
  3. **Potential Impact:** a credible, specific case for a real problem and audience, and the solution addresses it as demonstrated.
  4. **Innovation/Idea:** creative, novel, different from existing concepts.
  5. **Presentation:** the video shows it working end to end; the pitch says what problem, for whom, why it matters; easy to follow.
- **Ties:** highest score on the first criterion in the list above (Technological Implementation), then the next, then a judge vote.
- **Method:** the Rules say judging "may utilize expert panels, peer review, automated AI-driven analysis, or any combination". Judges are not required to run the project and may judge from description, images and video alone. Write the README and write-up so a model can read them, and keep them consistent with the video.

## 7. Prizes (Rules s.8)

Cash pool **$67,500** plus **$2,250** of Render credits = the "$69,750" in the overview.

| Prize | Amount | Winners |
|---|---|---|
| Grand: 1st / 2nd / 3rd | $12,000 / $8,000 / $5,000 | 1 each |
| Honorable: Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Agentic Commerce | $5,000 each | 1 each |
| Sponsor: AG Grid 1st / 2nd / 3rd | $5,000 / $2,000 / $1,000 | 1 / 1 / 3 |
| Sponsor: APIMatic | $1,000 + 6 months APIMatic Business | 3 |
| Sponsor: Bryntum | $1,000 | 3 |
| Sponsor: Channel3 | $1,500 | 1 |
| Sponsor: Render 1st / 2nd / 3rd | $1,000 / $750 / $500 in Render credits | 1 each |

No sponsor prize is listed for Astropods, Elastic, KERNEL, Postman or Zapier, although their tools are offered.

**Stacking rule:** one project can win at most **one Grand Prize and one Sponsor Prize, or one Honorable Mention and one Sponsor Prize**. Using several sponsor tools makes the project eligible for each, but only one sponsor prize pays. Sponsor-prize entries must follow the sponsor-specific requirements on the sponsor's page.

Payment: only after the winner affidavit and tax forms (W-9 for US residents, **W-8BEN** for others) are returned, within 10 business days of being sent; delivery within 60 days of receipt. Winners pay their own fees, currency-exchange costs and taxes; the Sponsor may withhold for tax. The prize goes to the Representative, who allocates it within the team. Awards are subject to identity and role verification.

Other terms: disputes by individual binding AAA arbitration, New York law, no class actions, no punitive or consequential damages (s.13). Questions: <mailto:janet@devpost.com> (hackathon manager) or the PayPal Discord.

## 8. Community and official channels

| Channel | Link |
|---|---|
| PayPal Discord (hackathon and sponsor support; each sponsor has a channel) | <https://discord.gg/sJ2G6DyvSK> (also <https://discord.com/invite/sJ2G6DyvSK>, <https://developer.paypal.com/discord>) |
| Devpost discussion forum | <https://paypalaihackathon.devpost.com/forum_topics> |
| Participants list | <https://paypalaihackathon.devpost.com/participants> |
| Updates feed | <https://paypalaihackathon.devpost.com/updates> |
| FAQs | <https://paypalaihackathon.devpost.com/details/faqs> |
| Calendar feeds | <https://paypalaihackathon.devpost.com/calendar> (Google and Outlook variants) |
| Devpost Terms / Privacy (incorporated into the Rules) | <https://info.devpost.com/terms>, <https://info.devpost.com/privacy> |

### FAQ highlights

- No maximum team size. Choose one Representative who submits.
- Add teammates through the Devpost project's team section: each teammate must be registered for the hackathon, then accept the invite link while logged in.
- You can use several sponsor tools; one sponsor prize maximum per project.
- Brazil is excluded; eligibility is in Rules s.3 and applies to every team member.
- If PayPal account sign-up is not offered in your country or for your phone number, ask in the PayPal Discord.

### Updates posted so far

1. Live Build Session Oct 6 (posted about 24 days before 2026-10-27's fetch, i.e. early October): announcement of the Zoom session.
2. FAQs page started; sponsor and PayPal questions go to the Discord.
3. Build-session recording posted. Linked resources: PayPal Developer Docs, PayPal AI Tools, AI Toolkit, Sandbox, Postman collection, example code. A feedback survey is offered.

## 9. PayPal resources (Resources page)

Core integration:

| Resource | Link |
|---|---|
| PayPal Developer (account, 5 minutes) | <https://developer.paypal.com/> |
| Payments | <https://developer.paypal.com/payments/> |
| Checkout | <https://developer.paypal.com/checkout/> |
| JavaScript SDK v6 | <https://developer.paypal.com/sdk/js/> |
| REST API | <https://developer.paypal.com/api/rest/> |
| Developer Dashboard | <https://developer.paypal.com/dashboard/> |
| Getting started with the sandbox | <https://github.com/paypaldev/getting-started-with-paypal-sandbox> |
| Example code | <https://github.com/paypal-examples/docs-examples> |
| Sandbox site | <https://sandbox.paypal.com/> |
| PayPal Postman workspace | <https://www.postman.com/paypal> |

Other capabilities the page lists: low-code/no-code payment links and buttons (<https://developer.paypal.com/payment-links-buttons/overview>), Pay Later (<https://developer.paypal.com/pay-later/overview>), Subscriptions (<https://developer.paypal.com/platforms/subscriptions>), Invoicing (<https://developer.paypal.com/invoicing/about>), Payouts (<https://developer.paypal.com/docs/payouts/>), Disputes (<https://developer.paypal.com/platforms/disputes/overview>), Donations (<https://developer.paypal.com/sdk/donate/>), Webhooks (<https://developer.paypal.com/api/webhooks/overview>).

AI and agent development:

| Resource | Link |
|---|---|
| PayPal AI Toolkit (GitHub) | <https://github.com/paypal/AI-Toolkit> |
| PayPal AI docs | <https://docs.paypal.ai/> (301-redirects to <https://developer.paypal.com/docsai/>) |
| Agent Toolkit quickstart | <https://docs.paypal.ai/developer/tools/ai/agent-toolkit-quickstart> |
| MCP server quickstart | <https://docs.paypal.ai/developer/tools/ai/mcp-quickstart> |
| Agent tools reference | <https://docs.paypal.ai/developer/tools/ai/agent-tools-ref> |
| AI tools landing page | <https://developer.paypal.com/ai-tools/get-started> |

Note: on 2026-10-27 the redirected `developer.paypal.com/docsai/...` pages returned 404 to a plain fetch, so the tool facts below come from the GitHub READMEs.

### What the PayPal AI repos contain **[linked]**

**AI Toolkit** (`paypal/AI-Toolkit`, Apache-2.0): a plugin that connects coding agents (Claude Code, OpenAI Codex, Cursor) to PayPal's APIs and a sandbox MCP server. It ships a `paypal-best-practices` skill (APIs, auth, webhooks, errors, sandbox testing), a routing skill, commands `/paypal:doctor`, `/paypal:explain-error`, `/paypal:sandbox`, `/paypal:setup`, `/paypal:test-accounts`, a `PreToolUse` hook that forces the agent to consult the best-practices skill and v5 or v6 SDK reference before editing PayPal code, and a sandbox MCP server over SSE. Claude Code install: `/plugin install paypal@claude-plugins-official`, then `/reload-plugins`. It needs a **sandbox access token** (OAuth client-credentials) placed in the agent's env config; tokens expire within up to 8 hours (`/paypal:setup refresh`). MCP capabilities: orders, payments, refunds, invoices, subscriptions, disputes, catalog, shipment tracking, transaction reporting and merchant insights.

**Agent Toolkit** (`paypal/agent-toolkit`, Apache-2.0, Node 18+, `npm install @paypal/agent-toolkit`): function-calling tools for the OpenAI Agent SDK, LangChain, Vercel AI SDK and MCP, with TypeScript and Python. Tool groups: invoices (19), payments (5: `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`), disputes (3: `list_disputes`, `get_dispute`, `accept_dispute_claim`), shipment tracking (3), catalog (3), subscriptions (7), reporting (2: `list_transactions`, `get_merchant_insights`). Sandbox mode is `configuration.context.sandbox = true`; each action group is enabled individually.

**Sandbox guide** (`paypaldev/getting-started-with-paypal-sandbox`): default sandbox gives one Personal (buyer) and one Business (seller) account; create more in the Dashboard; sandbox logins work only on sandbox.paypal.com; token endpoint `https://api-m.sandbox.paypal.com/v1/oauth2/token`; test failures with the `PayPal-Mock-Response` header (e.g. `INSTRUMENT_DECLINED`) or the Business account's Negative Testing setting (turn it off afterwards).

**Docs examples** (`paypal-examples/docs-examples`): minimal standard-integration and advanced (card form) examples plus a save-payment-method example, with Codespaces configs.

## 10. Inspiration categories (Resources page)

PayPal's own five idea buckets, none mandatory:

1. **AI agents or automation:** agents that transact on a user's behalf, shop and check out, pay contractors when a job completes, or settle between two agents (agent-to-agent commerce).
2. **Money movement experiences:** send by phone number, freelancer payment dashboards, instant gig payouts, receipt-scanned bill splitting, multi-cause donation splits.
3. **Business solutions:** multi-currency freelancer invoicing, creator tipping and membership, marketplace split checkout, small-merchant POS add-ons.
4. **Consumer experiences:** auto-categorising budgeting, request-money in chat, simpler checkout for students, families or seniors.
5. **Social impact:** accessible donation platforms, microloans for the underbanked, recurring nonprofit payouts, community pooling (solar co-op, cleanup fund).

## 11. Sponsor tools

Using a sponsor tool is optional but is the entry to that sponsor's prize. Support for all of them is in the PayPal Discord.

| Sponsor | What it is | Access | Prize | Page |
|---|---|---|---|---|
| **AG Grid** | AG Studio: embedded analytics (dashboards, charts, grids) with a built-in data engine, cross-filtering and the **Studio Agent Framework** so agents build, query and edit dashboards | Free 45-day trial licence; boilerplate with AG Studio and PayPal: <https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate> (Next.js, TypeScript, AG Grid and Studio, PayPal REST via `fetch`, optional OpenAI assistant, Node 20.9+) | $5,000 / $2,000 / 3 x $1,000. Judged on polish (custom widgets, theming, layout) and on using the Agent Framework (custom agent talking to Studio's agents, or a swapped-in harness) | <https://paypalaihackathon.devpost.com/details/aggrid> |
| **APIMatic** | Context Plugins that give a coding agent PayPal API context | PayPal already enabled in the plugin, no extra credentials. Free subscription claim form linked from the page: 1 month APIMatic Basic for participants who used the plugin | 3 x ($1,000 + 6 months Business) | <https://paypalaihackathon.devpost.com/details/apimatic> |
| **Astropods** | Agent operating system: declarative agent spec, CLI build and push, deploy through API or dashboard, observability, Slack connection | Free account at astropods.com; docs <http://docs.astropods.com/>; four walkthrough videos | none listed | <https://paypalaihackathon.devpost.com/details/astropods> |
| **Bryntum** | Gantt, Scheduler, Calendar components | 45-day trial: `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial`, <https://bryntum.com/download/> | 3 x $1,000. Ideas include a dispute triage board and an agent-driven rescheduler reacting to PayPal payment events | <https://paypalaihackathon.devpost.com/details/bryntum> |
| **Channel3** | One API for normalised product data (100M+ products, 25,000+ retailers) and an MCP server, for shopping agents | Key at <https://trychannel3.com/developers>, no card; 20,000 free credits with promo code `PAYPAL-HACKATHON-2026`; top-ups via the Discord. The API or MCP must really be called | $1,500 | <https://paypalaihackathon.devpost.com/details/channel3> |
| **Elastic** | Elasticsearch with Jina embeddings, Agent Builder, Workflows, ES\|QL, A2A and MCP | 14-day serverless trial at <https://ela.st/elastic-paypal-hackathon>, extendable 30 days (<https://www.elastic.co/trialextension>); or run Elasticsearch locally | none listed | <https://paypalaihackathon.devpost.com/details/elastic> |
| **KERNEL** | Cloud browsers for agents (under 30 ms spin-up, anti-detection, live view, replay, persistent auth) | $50 credit through the hackathon link on its page | none listed | <https://paypalaihackathon.devpost.com/details/kernel> |
| **Postman** | API design, test, document, monitor | Free; PayPal collection at <https://www.postman.com/paypal>; learning path <https://www.postman.com/liftoff/learning-paths/building-with-ai/> | none listed | <https://paypalaihackathon.devpost.com/details/postman> |
| **Render** | Cloud hosting plus **Render Workflows** (orchestration for AI agents, jobs, pipelines) | $50 credit claim page linked from its page; credits applied per <https://render.com/docs/credits>; docs <https://render.com/docs/workflows> | $1,000 / $750 / $500 in credits | <https://paypalaihackathon.devpost.com/details/render> |
| **Zapier** | Zapier MCP: AI tools act across 9,000+ apps including PayPal | New account gets a 14-day Professional trial, then the free plan; docs <https://docs.zapier.com/mcp/get-started/quickstart> | none listed | <https://paypalaihackathon.devpost.com/details/zapier> |

## 12. Open questions

- Winners-announcement time (9:00 am PST vs 2:00 pm PT).
- The project gallery is unpublished, so the number of submissions is unknown. Registration is 22,116.
- `docs.paypal.ai` redirect targets returned 404 when fetched; recheck the AI docs for any tool added after the READMEs.
- Sponsor-prize "specific requirements in section 8" are only the sponsor pages' text (AG Grid, Channel3 usage rules); no separate legal text exists beyond that.

## 13. Link index

Devpost: overview <https://paypalaihackathon.devpost.com/> · rules `/rules` · schedule `/details/dates` · FAQs `/details/faqs` · resources `/resources` · updates `/updates` · gallery `/project-gallery` · register `/register?flow[data][challenge_id]=31302&flow[name]=register_for_challenge` · submit <https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions>.

Sponsor sites: <https://www.ag-grid.com/studio/> · <https://www.apimatic.io/about> · <https://astropods.com/> · <https://bryntum.com/> · <https://trychannel3.com/> (docs <https://docs.trychannel3.com/>, MCP <https://trychannel3.com/mcp>, examples <https://penny.shop/>, <https://signup.zamana.com/>, <https://www.folk.com/>) · <https://www.elastic.co/elasticsearch> · <https://www.kernel.sh/docs> · <https://www.postman.com/> · <https://render.com/docs/workflows> · <https://zapier.com/mcp>.

AG Grid docs: <https://www.ag-grid.com/studio/react/quick-start/> · <https://www.ag-grid.com/studio/react/custom-widgets/> · <https://www.ag-grid.com/studio/react/ai-agents/> · <https://www.ag-grid.com/blog/introducing-the-ag-studio-agent-framework/> · <https://www.ag-grid.com/studio/license-pricing/> · <https://app.livestorm.co/ag-grid/self-service-dashboards-30-lines-of-code>. Bryntum: <https://bryntum.com/products/gantt/> · `/products/scheduler/` · `/products/calendar/` · <https://bryntum.com/examples/>.
