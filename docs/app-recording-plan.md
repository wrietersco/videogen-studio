# App-recording videos — implementation plan

**Version 1.3 · 2026-11-13 · shipped in v0.3.27**
*1.1: full exploration is now the default; restrictions are opt-in checkboxes and typed rules. 1.2: explorer defined (section 5.1), stale wording fixed. 1.3: status of what shipped (section 16).*

This is the plan for the feature where a person gives VideoGen Studio a web-app address and a login, and the app explores it, rehearses it, records it with private data hidden, and turns the recording into a finished video.

It was built from three sources: the original feature request and the design critique you agreed to on 2026-11-12, the proof that was recovered on 2026-11-13, and a line-by-line challenge of that proof's code. Section 3 is the challenge. It found real defects, and the plan below fixes them.

---

## 0. Read this first

**What exists today.** A proof (recovered, committed, 16 tests passing) that records one hardcoded sign-in flow on a public practice site and produces a 44-second launch-style video. There is no screen for it in the app.

**What this plan delivers.** One page in the app ("Record an app") where a person enters an address, a login, what the video should show and any restrictions. One button makes the video. It runs safely, hides private information, and lands in My videos.

**Default behaviour (decided 2026-11-13): explore the app to its full potential.** By default the engine clicks, fills, creates and navigates as a real user would. It is held back only by what the person chooses: typed rules, or checkboxes on the form. The terms of use and a one-time notice cover the person's responsibility for what they point the tool at. Section 6 describes the optional restrictions and the few basics that stay on because they protect the person's own credentials or keep the run working, not because they limit exploration.

**The four biggest changes from my first plan:**

1. **Ship the login walkthrough first, in the app, before general exploration.** That is your own example, and it is the lowest-risk slice. Exploring any app and deciding what to show is the riskiest part, so it comes second, after real feedback.
2. **Harden the proof before building screens.** The recovered safety layer has holes that a real customer's app would find (section 3). A friendly screen on top of a leaky engine is the wrong order.
3. **Be honest about what "blurred" guarantees.** The app always hides passwords and the other fields it recognizes as secret. It cannot promise that a real app's data tables contain nothing private, so a "hide personal data in tables and lists" checkbox exists for people recording real accounts, and the finished video is always shown for review before anything is shared.
4. **Full exploration by default, restrictions opt-in.** The proof's read-only and blocked-word rules become checkboxes the person can tick, not defaults.

---

## 1. What the person experiences

One page, top to bottom:

1. **Saved apps** (a short list; first time it is empty). Pick one or add a new one.
2. **The form**
   - Address of the web app.
   - What should the video show? Typed, plus an optional attached document.
   - How to sign in: **I'll sign in myself** (a real browser window opens; the app never sees the password) or **Use a saved login** (stored encrypted on this computer).
   - **Restrictions (optional).** A typed box for any rule, plus checkboxes (section 6.2). Nothing is restricted unless the person asks. When any rule is set, the app repeats it back: "I will never do X. I cannot check Y automatically."
   - Video type: **Walkthrough** or **Launch film**. A launch film asks for the feature name, a tagline and a closing line.
   - Look: brand kit, reference pictures and a reference video, using the components that already exist.
3. **Before it starts:** estimated cost and time, and a limit the person can set. The first time the feature is opened, a one-time notice (section 6.6).
4. **Two buttons:** *Save app* and *Make my video*.
5. **While it runs:** a progress list (Exploring, Planning, Verifying, Recording, Producing). A banner says the app is driving a browser, with **Stop** and **Take over**. If a one-time code or similar is needed, a notification appears and a browser window opens for the person.
6. **Review (optional).** A "review the steps first" switch, off by default. The run pauses after planning only if the switch is on, or if the person typed a rule the app cannot enforce (for example "only customer01"). The person sees the steps and the list of blurred items, edits them, and approves.
7. **Result.** The video plays on the same page and is saved to My videos. A short note suggests watching it before sharing, since the app can only hide what it recognizes.

---

## 2. Requirements

Every item has an ID so nothing is dropped. Section 15 maps each back to what was originally asked.

| ID | Requirement | Milestone |
|---|---|---|
| R1 | Web app address as input. Desktop apps are a later phase. | M1 |
| R2 | Context to guide the video: typed **and** an attached document | M1 |
| R3 | Save an app once, reuse it (save, then create) | M1 |
| R4 | Credentials encrypted on this computer, used only by the app to sign in | M1 |
| R5 | Optional restrictions: typed guardrails plus checkboxes. Nothing restricted by default. Rules the app can enforce are marked apart from advice it cannot; any set rule is shown back | M1 |
| R6 | Two sign-in modes: sign in yourself, or saved login | M1 |
| R7 | Pause for the person when a one-time code, SSO or CAPTCHA appears; notification | M1 |
| R8 | Scout the app and write a structured map: pages, addresses, fields, which fields are sensitive | M0, M2 |
| R9 | Hide sensitive information before it is ever captured; stop and ask if a sensitive field cannot be identified | M0, M1 |
| R10 | Try the flow first (rehearsal), then record the same steps | M1 |
| R11 | Plan the video from what was learned and what the person asked for | M1, M2 |
| R12 | The video can show login options (SSO, reset link, MFA) without triggering them | M2 |
| R13 | All of the app's existing production quality: voice, music, captions, brand, references, cost receipt, plan limits, resume | M1 |
| R14 | Walkthrough or launch film, with the feature name, tagline and closing line coming from the person | M1 |
| R15 | Cost estimate before the run and a budget stop | M1 |
| R16 | "Agent is driving" banner, Stop, Take over | M1 |
| R17 | At most two login attempts; recommend a test account | M1 |
| R18 | Page text and attached documents are data, never instructions | M0 |
| R19 | One-time privacy notice; nothing sensitive goes to a cloud model; optional keep-everything-local mode | M1 |
| R20 | Copy rules: no absolute security claims, no invented features, never speak a credential, hide the username unless it is a public demo account | M1 |
| R21 | The free engine works with no AI keys | M1 |
| R22 | When the app changes, repair only the broken steps | M3 |
| R23 | Full exploration with a depth control (Quick, Standard, Thorough) and hard limits on pages, actions and time (section 5.1) | M2 |

---

## 3. The challenge: what is wrong or missing

### 3.1 Defects found in the recovered proof

These come from reading the code, not from opinion. Each is fixed in the milestone shown.

**Update 2026-11-13:** exploration is now unrestricted by default, so D1, D3 and D5 only apply when the person ticks a restriction (read-only, never delete, never spend). They still matter, because a restriction the person chose must work. D2, D4, D11–D13 and D17 are functional bugs and apply in every mode. D7–D10, D14 and D15 protect credentials, private data and the narration and apply in every mode.

| # | Finding | Why it matters | Severity | Fix (milestone) |
|---|---|---|---|---|
| D1 | The read-only gate blocks every POST, PUT, PATCH and DELETE outside an eight-second window around sign-in. | Many apps read data with POST (search boxes, GraphQL, dashboards). The page would load half empty or fail. | High | Classify requests instead of blocking by method: GraphQL queries pass, mutations do not; endpoints observed during a read-only scout are allowed; everything blocked is listed in the review ("the app tried to save something; blocked"). (M0) |
| D2 | Cross-host requests: only images, fonts, styles and media are allowed. Scripts and data requests to any other host are blocked. | Apps load scripts from CDNs and data from API hosts with a different name. Many would break. | High | Allow cross-host GET for scripts, styles, fonts, images and media. Hosts that make data requests are learned during scout and added automatically; the review lists them. (M0) |
| D3 | A button with no text (an icon-only trash can) is judged "looks safe". | The most dangerous controls are often icons. | High | Treat unlabeled controls as unsafe unless they are plain navigation. Read accessible names, titles and icon hints. (M0) |
| D4 | "Log out" and "Sign out" are not in the blocked list, only the declared sign-out step is allowed. | A crawl that clicks "Logout" ends its own session mid-run. | High | Add them; sign-out only ever happens as a declared step. (M0) |
| D5 | Links are judged by label only. A link to `/delete?id=3` or `/logout` is a GET that the gate allows. | Some apps change data on GET. | Medium | Also check the link's address for risky words; never follow such a link while exploring. (M0) |
| D6 | The "blocked words" check can miss words inside longer phrases or other languages. | Customers use other languages. | Medium | Keep the word list, add the unlabeled rule (D3), and force playbook review for any app whose language is not English. (M2) |
| D7 | Blurring covers known fields and known secret values only. Verification checks the same things it blurred, so "0 unblurred items" cannot see unknown personal data such as customer names in a table. | A clean result is not proof that nothing private is on screen. | **Critical** | Pattern detection on visible text (emails, phone numbers, card-like numbers, long digit strings, tokens); an optional privacy mode that blurs the contents of tables, lists and cards; a review of the finished video; honest wording in the UI. (M0, M1) |
| D8 | Blurring uses CSS on page elements. It does not reach shadow DOM, canvas or WebGL drawings, images such as avatars and receipts, or content inside frames from another site. | Those could show private data with no warning. | High | Detect these containers during scout and blur them whole, or stop and ask. Test frames explicitly with the fixture site. (M0) |
| D9 | The scout stores page notices and titles in the app map. They can contain private text ("Welcome back, Jordan Smith"). | The map is sent to a writer model and saved to disk. | High | Run the same pattern detection on the map before it leaves the main process; only the scrubbed map is ever sent to a model. (M0) |
| D10 | The address bar in the video shows host and path. The path can hold an ID or an email (`/customers/48213`). | A private value shown in a corner of every frame. | Medium | Replace ID-like and email-like path segments in the displayed address. (M0) |
| D11 | Each stage uses a fresh private browser context, so a session never carries from scouting to rehearsal to recording. | Fine for stored logins (each stage signs in again), useless for the person-signs-in mode. | Medium | One browser process for the run. Person-signed-in mode keeps the session in memory for the run only. (M1) |
| D12 | The browser runs headless. A person cannot type a code into it. | The sign-in-yourself mode cannot work. | High | Show a normal browser window for scouting and rehearsal in that mode; record afterwards with the session carried over. (M1) |
| D13 | Chrome is found only if Chrome or Edge is installed. | Without it, nothing works and the error is blunt. | Medium | Prefer Edge or Chrome. Otherwise reuse the app's own downloaded headless browser for recording, and say plainly that sign-in-yourself needs Edge or Chrome. (M0) |
| D14 | A secret is typed only where the playbook says. Nothing stops a bad plan from typing the password into a different field on the page. | A malicious page or document could steer a plan toward a credential-stealing field. | High | The vault may fill only fields classified as username or password, on an allowed host, and only into the declared sign-in step. (M0) |
| D15 | Narration is not scanned before it is voiced. | The writer could repeat a secret or a customer name aloud. | High | Scan every script line against the vault values and the pattern detectors before text-to-speech; regenerate or fall back to the stock line. (M0) |
| D16 | The recorded session profile folder stays on disk after a run. | Session cookies at rest are credentials. | Medium | Delete the profile and raw frames when the run ends; "Forget this app" removes everything. (M1) |
| D17 | Project saving and the editor assume a normal scripted video (stage names, a spec). A recording is not one. | "My videos" and "Change a scene" may break or mislead. | Medium | Register a recording with its own kind; show a play-and-redo view instead of the scene editor. Checked in M1. |

### 3.2 Things the original plan assumed that need a harder look

| Assumption | Challenge | Resolution |
|---|---|---|
| "The app can explore any web app." | Canvas-based apps, heavy single-page apps, apps behind bot detection or CAPTCHAs and apps with unusual widgets will fail in unpredictable ways. | Never claim "any app". Run a **compatibility check** at the start of scouting that says "works well", "might need your help" or "unlikely to work" before any money is spent. M0 measures this on a set of real and fixture apps; if too few pass, the supported list is narrowed rather than hidden. |
| "The AI plans the steps." | The riskiest and least predictable part, and the free engine has no AI. | The **explorer** (section 5.1) is deterministic and works without AI: it signs in, then explores within limits. The AI planner improves what the video features in M2 but never replaces the explorer, and its output must respect the person's restrictions. |
| "Credentials plus authenticator secret = hands-free runs." | Saving the one-time-code seed next to the password defeats the second factor for that account. | v1 offers sign-in-yourself for any account with a second factor. Authenticator-secret storage arrives in M3 behind a clear warning and a recommendation for a dedicated test account. |
| "Guardrails are enforceable." | "Only customer01 in the ABC module" cannot be checked by software. | Such rules are shown as **not enforced** and force a playbook review where the person confirms each step is in scope. |
| "Blur gives privacy." | See D7 and D8. | Always-on blur for secrets, an optional privacy checkbox for tables and lists, pattern detection, and a review of the finished video. The UI says exactly what is and is not guaranteed. |
| "One button, no review." | Fine for most runs. | Review is an optional switch, forced only when the person typed a rule the app cannot enforce. |
| "Full exploration is free of side effects." | Exploring and then recording performs real actions twice: records created twice, messages sent twice, money spent twice. A failed write step retried automatically could repeat it again. | Exploration doubles as the rehearsal, so a data-changing step runs at most twice (once exploring, once recording), never three times. The later verify pass skips steps that change data. Created data gets unique names (for example a timestamp suffix). A failed write step is never retried automatically; the app asks. A line before the run reads "This run will perform real actions in the app." |
| "It fits the existing pipeline." | The recording is produced by its own video step. It will not be editable scene by scene. | Accept this for v1: frame-accurate screen footage matters more. State it in the UI ("To change this video, record it again"). |

### 3.3 Things I would have regretted leaving out

- **Authorization.** Recording someone else's app, or an app whose terms forbid automation, is the person's responsibility. This is covered by the app's terms of use and a one-time notice the first time the feature is opened (not a screen per app).
- **Lockouts.** A rehearsal and a recording each sign in. At most two attempts in total per run, so a wrong password cannot lock an account.
- **Concurrency.** Recording is CPU-heavy (browser screencast plus video encoding). One recording at a time, counted inside the existing three-job limit.
- **Downloads and uploads.** Blocked in v1. A file chooser is treated as "needs your help".
- **Cookie banners.** Default is decline non-essential, the app's existing privacy default.
- **Partial failure.** If step 4 of 6 fails (steps that only read are retried once; steps that change data are never retried), ask: "Record what worked" or "Stop".
- **Retention.** Raw frames and browser profile deleted when the run ends; the app map, playbook and final video stay with the project.

---

## 4. Design decisions

| # | Decision | Why |
|---|---|---|
| 1 | Web apps first. Desktop apps are a separate later project. | Web pages can be read and controlled through their structure; desktop apps cannot. Agreed 2026-11-12. |
| 2 | Rehearse once, record from a reviewable playbook. The AI never drives the recorded take. | Predictable, repeatable, auditable. |
| 3 | Restrictions the person chooses are enforced outside any model, on facts: host, request type, control, field class. | A model can be talked out of a rule by a page. |
| 4 | Hide private data inside the page before frames are captured; verify after every step; stop on any miss. | Fixing it in the finished video is unreliable. |
| 5 | Credentials never reach a model. The model sees `{{password}}`. | Privacy. |
| 6 | The free engine is complete without AI keys; AI only improves the plan and the voice. | "The free engine is the product" (your 2026-11-13 decision). |
| 7 | One page, not five screens. | Your decision 2026-11-13. |
| 8 | Show login options without triggering them. | Demonstrates secure access without risking a real account. |
| 9 | The recording keeps its own video step. | Frame accuracy; the existing scene composer is built for generated scenes. |
| 10 | Local fixture test site first, real public sites second. | Repeatable tests that do not depend on someone else's website. |
| 11 | **Full exploration by default; restrictions are opt-in** (typed rules and checkboxes). Decided 2026-11-13. | The person has accepted the app's terms of use; the tool should do what they ask without second-guessing. |
| 12 | A short list of basics stays on in every mode (section 6.2). | They protect the person's own password and keep the run working. They do not limit what gets explored. |
| 13 | Exploring is not the same as recording. The explorer covers as much of the app as its limits allow; the video features only the 4–8 beats that best answer what the person asked for. | A video of everything would be unwatchable. |
| 14 | Exploration doubles as the rehearsal. | Avoids a third round of real actions. |

---

## 5. Architecture

```
Saved app (address, encrypted login, rules, brand)
        │
Mission  = what the video should show (typed text + attached document, treated as data)
        │
Restrictions engine ─ outside any model ─ only the rules the person chose, plus the always-on basics (section 6.2)
        │
One browser process (Edge/Chrome, or the app's own headless browser for recording)
   1. Explore    → app map (scrubbed): pages, fields, sensitivity, hosts, compatibility; actions are really performed (section 5.1)
   2. Plan       → playbook of 4–8 beats chosen from what was explored (deterministic ranking; AI improves it)
   3. Verify     → quick pass over the chosen playbook in the same browser session; steps that change data are skipped (exploration already proved them)
   4. Script     → narration lines (scanned for secrets and private patterns before voicing)
   5. Record     → blurred frames + event timeline
   6. Produce    → camera, window frame, voice, music, captions, brand cards
        │
Saved to My videos → preview with Re-record
```

### 5.1 The explorer

The explorer is the engine that "explores the app to its full potential". It is deterministic, works with no AI keys, and runs inside one browser session.

**How it works**
- **Order of attention.** Main navigation first, then each page's primary actions, then forms, then secondary links. Pages with the same shape (for example `/customers/12` and `/customers/13`) are treated as one template and visited once or twice.
- **It really performs actions** unless the person restricted them: it presses buttons, opens menus and tabs, submits forms and follows links, the way a user would. Everything it does is recorded in the map and the audit file.
- **Form filling.** The explorer fills forms with realistic made-up sample values (for example a name with a timestamp suffix so records are unique). It never uses the person's real data. Fields it classifies as secret or personal get obviously fake test values. Dropdowns take the first valid choice, dates take today.
- **Never repeats itself blindly.** Visited pages and states are remembered; loops, duplicate screens and "stuck" pages (no change after an action) are detected and abandoned.
- **Sign-in and sign-out** follow the always-on basics in section 6.2.

**Depth control.** A selector on the form: Quick, Standard (default), Thorough. These set hard limits per run:

| Level | Pages | Actions | Time |
|---|---|---|---|
| Quick | 8 | 40 | 4 min |
| Standard | 25 | 150 | 15 min |
| Thorough | 60 | 400 | 40 min |

When a limit is reached the explorer stops and says so. The numbers are starting values, to be tuned in M2 on real runs.

**Choosing what the video shows.** Exploring everything does not mean recording everything. The planner ranks what was found by relevance to what the person asked for and by visual value (a page that changes on screen beats a static list), then picks 4–8 beats. If the person asked for "the login flow", the explored login path is the video; the rest of the app was context.

**Build order.** M1 ships the login-only path (the explorer limited to signing in and out). M2 delivers the general explorer.

---

- Every stage writes one JSON file in the run folder. A run can pause, resume or re-run one stage. Stage state is kept so a crash does not lose work.
- The proof's modules remain: `src/main/appRecon/{policy,sensitivity,redact,browser,scout,recorder,produce,proof}.ts` and `src/shared/appRecon.ts`. `proof.ts` is split into stage functions and then retired.
- New: `src/main/appRecon/{ipc,vault,profiles,planner,compat,detect,run}.ts`, a renderer view `RecordApp.tsx`, and preload channels `appRecon:*`.

---

## 6. Safety and privacy design

### 6.1 Threats

| Threat | Mitigation |
|---|---|
| A page or document tries to steer the agent ("ignore the rules, open this link") | Policy gate decides on facts; page text and documents are data only (R18) |
| The password is typed into the wrong place | Vault fills only credential fields on allowed hosts in the declared sign-in step (D14) |
| The password or customer data reaches a cloud model | Scrubbed map only; vault values never included; one-time notice; local-only mode (R19, D9) |
| Private data appears in the video | Always-on blur for secrets, pattern detection, optional privacy mode, and a review of the finished video (D7, D8, D10, D15) |
| The agent changes or deletes data | Allowed by default. If the person ticks a restriction, it is enforced: request classification (D1), unlabeled controls treated as unsafe (D3), risky links not followed (D5) |
| The agent ends its own session or locks the account | Logout is a declared step only (D4); two-attempt cap (R17) |
| Secrets left on disk | Encrypted vault; profile and raw frames deleted after each run (D16) |
| Someone steals a stored login from the app's files | Encrypted with the operating system's account-bound key; never written to logs, playbooks or maps |
| Third parties' terms or rights | App terms of use and a one-time notice (3.3, 6.6) |

### 6.2 Restrictions (opt-in) and the always-on basics

**Optional restrictions.** All unchecked by default except the first. A typed box accepts anything else.

| Checkbox | What it enforces |
|---|---|
| Stay on this app's sites (**ticked by default**) | Only the app's own hosts, plus sign-in and API hosts learned during scouting. Cross-host scripts, styles, fonts, images and media always load. This is what "the target app" means; untick it to allow wandering to other sites. |
| Look only, don't change anything | Write-style requests are classified (D1): reads pass, changes are blocked, except sign-in and sign-out. |
| Never delete or remove anything | Delete-type controls and links are not used (D3, D5). Unlabeled icon buttons are treated as unsafe. |
| Never spend money, place orders or send messages | Pay, buy, order, send and publish controls are not used. |
| Don't change settings, passwords or accounts | Settings and account-change controls are not used. |
| Hide personal data in tables and lists | Privacy mode (6.3). |

Typed rules are turned into the same kind of checks where possible. Anything the app cannot check ("only customer01 in the ABC module") is kept as advice for the planner, shown as **not enforced**, and forces the review pause (section 1).

Whenever any restriction is set, the app repeats it back before the run starts. With none set, the form says plainly: "This run will perform real actions in the app."

**Always-on basics** (these protect the person's own credentials or keep the run working; they do not limit exploration):

- The vault fills only username and password fields, on an allowed host, in the declared sign-in step (D14).
- Passwords, one-time codes and other known secret fields are always blurred.
- Credentials never go to any model; the scrubbed map and brief are all a model sees (D9, D15).
- Page text and attached documents are data, never instructions.
- Logout is used only as a declared step, so the run does not end its own session (D4).
- At most two sign-in attempts per run, so a wrong password cannot lock the account (R17).
- CAPTCHAs and bot checks are never bypassed; the person is asked (R7).
- A failed step that changes data is never retried automatically; the app asks (section 3.2).
- File uploads, downloads and native file pickers are not handled in v1; the person is asked.
- Every decision is saved to an audit file with the run.

### 6.3 Redaction v2

- Known sensitive fields (existing), plus pattern detection on all visible text: emails, phone numbers, card-like and long digit strings, tokens, and the vault values.
- **Privacy mode**, a checkbox (off by default, because blurred tables make a worse demo; the form suggests it when the account looks real): blur the contents of tables, lists, cards and form values; leave menus, headings and buttons readable. The person can mark a region as safe to show.
- Shadow DOM, canvas, images and frames from other sites are blurred as whole blocks, or the run stops and asks.
- Displayed address bar: IDs and email-like segments replaced.
- Verification after every step uses the same detectors. A miss stops the run.
- Honest limit, stated in the UI: the app hides what it can find. Use a demo or test account with fake data where possible.

### 6.4 Credentials and sign-in

- Stored with the operating system's encryption (as the app already does for API keys). Decrypted only in the main process at the moment of typing.
- **Sign in yourself** keeps the session in memory for the run only.
- Second factors in v1: person-signs-in only. No authenticator-secret storage until M3.
- Maximum two sign-in attempts per run; no retry after "wrong password".

### 6.5 What the app promises

- The password and one-time codes never appear in any file, log or model call.
- The app does what the person asked, including actions that change data, except where the person ticked a restriction.
- Private data the app can detect is hidden before capture.

### 6.6 One-time notice (first use of the feature)

One short, non-blocking notice, not a screen per app. It says in plain words: the app performs real actions in the target app unless restricted; what goes to a cloud writer or voice (only the scrubbed map and the video brief); what never leaves the computer (passwords, frames, screenshots); the local-only option; and that the person is responsible for having the right to automate and record the app. The terms of use carry the legal wording.

---

## 7. The page: details

- **Compatibility result** appears after scouting starts: Works well / Needs your help / Unlikely to work, with the reason.
- **Restrictions readback** (only when something is set) lists what is enforced, what is advice only, and the hosts the app learned it needs.
- **Review pane** shows steps (reorder, remove, edit narration), the blurred-items list (add or remove regions), blocked requests and the policy audit summary.
- **Handoff window** explains why it opened and what to do; a **Done** button returns control.
- **Failure messages** are plain and actionable ("The sign-in button could not be found. Record the steps again or choose the button yourself").
- **Cost line** before starting: estimated AI cost (if any) and time; running total while it works; limit stops the run.

---

## 8. Pipeline integration

- Registered as a project of a new kind with its own run folder, so it appears in My videos with a cost receipt.
- Uses the existing voice, music, captions, loudness and brand-kit code; logos and colors from the chosen brand kit go on the title and closing cards; reference pictures and videos steer style.
- The usage meter and plan allowance apply: a recording counts as one video only when AI narration or voice is used (decision 11.1).
- Within the three-parallel-job limit; at most one recording at a time.
- Resume: each stage's JSON is the checkpoint.
- Not editable scene by scene in v1 (section 3.2).

---

## 9. Delivery plan

Sizes: **S** (days), **M** (about a week), **L** (more than a week). Nothing is released or merged to `main` without your explicit go.

### M0 — Harden the engine (no screens) · size L

Tasks
- Fix D1–D5, D7–D10, D13–D15 (section 3.1).
- Build the **local fixture site** (section 10) and cover each defect with a test.
- Compatibility check.
- Stage functions with JSON checkpoints; split `proof.ts`.
- Stop-and-ask behavior when a sensitive field cannot be identified.

Exit criteria
- All fixture-site tests pass, using scripted playbooks (the general explorer comes in M2), including: with no restrictions, data-changing requests and buttons work; POST-based reads render; cross-host scripts load; logout is never clicked while exploring; with "never delete" ticked an icon-only delete button is never clicked; with "look only" ticked no data changes; private text in a shadow DOM and a frame is blurred or stops the run; address bar hides IDs.
- Three public practice sites record cleanly.
- **Kill or narrow rule:** if fewer than four of the six fixture app types record without manual fixes, narrow the supported claim to standard web apps and make the compatibility check stricter before building M1.

### M1 — Login walkthrough in the app · size L

Tasks
- Page and saved apps; vault; one-time notice; restrictions readback; both sign-in modes (D11, D12); two-attempt cap; Stop and Take over; notification.
- Login-only explorer (sign in, sign out) and a fixed beat plan; walkthrough and launch-film modes; brand kit, references.
- Cost estimate and limit; preview of the finished video with Re-record; project registration and recording view (D17); cleanup (D16).
- Entitlement and superadmin switch.

Exit criteria
- A person who has never seen the proof can record a sign-in video of a fixture app and a public site from the app, without help.
- The free engine alone (no keys) produces a complete video.
- The vault password is absent from all logs, files, maps and model requests (checked by a test that searches the run folder).
- Real-app run through the running app window (see section 10) with zero unblurred items and the final preview working.

### M2 — Explore and explain · size L

Tasks
- The general explorer (section 5.1): depth levels, limits, form filling, template detection, stuck detection.
- Beat selection: deterministic ranking, then the AI planner on top, both respecting the person's restrictions.
- Scope rules ("only customer01") with forced review; login-options step (R12).
- Editable playbook and blurred-items editor.
- Language check (D6).

Exit criteria
- With no restrictions, the explorer reaches and uses every page, form and button it safely can on the fixture site within the Standard limits, and stops at the limits on a larger site.
- A person gets a sensible multi-page video of two different fixture apps; scope rules are shown as not enforced and force review.
- No step in any run does something the person's ticked restrictions forbid (audit file checked in tests). With no restrictions, the tour covers the app's main areas, not only the first few menu items.

### M3 — Keep it working · size M

- Reuse saved app and repair only the broken steps (R22).
- Optional authenticator-secret storage with the warning.
- Camera polish (the zoom that hunts on wide pages).
- Health check that tells a person their saved playbook no longer matches the app.

### M4 — Later

Desktop apps (needs your clarification of "select a desktop application from the browser"), editing recordings scene by scene, organization-shared app profiles.

---

## 10. Testing

1. **Unit tests** for the gate, detectors, vault, planner (with a fake writer), script scanner and request classifier.
2. **Local fixture site** (a small localhost web app inside the repo's tests) with: a login, a POST-based search, GraphQL read and mutation, a cross-host script, a shadow-DOM component, a canvas, an iframe from another origin, an icon-only delete button, a logout link, a table of personal data, a one-time-code page, a cookie banner, a slow page and a page that tries to instruct the agent in its text. No internet needed.
3. **Public practice sites** with published demo logins: the-internet.herokuapp.com, saucedemo.com and practicesoftwaretesting.com (verify each still publishes its demo login at test time).
4. **Real app**: drive the packaged-style app window with the debug port and puppeteer, as in the project's earlier practice.
5. **Cheap models** for any AI call in tests, including voice; use the free engine first.

---

## 11. Plans, cost and decisions

1. **Who gets it.** All plans. The free path costs nothing. AI narration and voice follow the plan's rules, and an AI-assisted recording counts as one video of the plan's allowance. Free-engine recordings are not counted. The superadmin can turn the feature off for a licence.
2. **Local-only mode** (no cloud writer, stock script, local or no voice) is available to everyone.
3. **Cost estimate** = writer tokens (small) + voice (per second of narration) + nothing for the recording itself, since the recording uses the person's computer.

---

## 12. Risk register

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Many real apps are hard to record | High | High | Compatibility check; narrow claims; M0 kill rule |
| Private data slips through blur | Medium | High | Always-on secret blur, detectors, optional privacy mode, review note, honest wording |
| Sites block automated browsers | Medium | Medium | Person-signs-in mode; never bypass bot checks |
| Slow runs on weak computers | Medium | Medium | One recording at a time; show time estimate; scale the frame size |
| Planner proposes odd steps | Medium | Medium | Restrictions engine, optional review switch (forced when a rule cannot be enforced), deterministic fallback |
| Chrome or Edge missing | Low | Medium | Fallback browser for recording; clear message |
| Scope creep to desktop apps | Medium | High | Out of scope until clarified |
| Real actions on a real account (data created twice, messages or orders sent) | Medium | High for the person | Unique names for created data; no automatic retry of write steps; plain "this run performs real actions" line; checkboxes to restrict; a demo or test account is suggested in the form |

---

## 13. Decisions made and open questions

**Made (change any time):** sections 4 and 11.

**Still open:**
1. What was meant by "select a desktop application from the browser"? Not blocking; desktop apps are M4.
2. ~~Should a writing mode exist?~~ Settled 2026-11-13: full exploration, including actions that change data, is the default; restrictions are opt-in.

---

## 14. Release hygiene

- Delete `scripts/_recon-proof.ts` and any scratch files before a release.
- Stage explicit files; other sessions edit the main checkout concurrently.
- Build any installer from a snapshot of HEAD, as in the release recipe.
- Do not merge to `main`, push or release without an explicit go from you.

---

## 15. Traceability: your request → this plan

| Your words (2026-11-12) | Where |
|---|---|
| "provide url for web app (or select a desktop application…)" | R1, M1; desktop in M4 |
| "ask user to authenticate the app if auth is required" | R6, R7, section 6.4 |
| "provide context… typing in… attaching a document" | R2, section 1 |
| "wait for user's input to initiate understanding" | Save, then Make my video (R3); review pane |
| "credentials… encrypted… agent can utilize to login" | R4, section 6.4 |
| "guardrails… 'only record… customer01', 'do not delete or update any data'" | R5, section 6.2 and 3.2 |
| "explore… screenshots, URLs, field level definitions, structured json" | R8, section 5 |
| "fields that would need blurring" | R9, section 6.3 |
| "try out login… prompting user for otp" | R7, R10, R17 |
| "repeat the process and record the steps" | R10 |
| "plan the video… illustrate logic options" | R11, R12 |
| "do all the magic that the current application has" | R13, section 8 |
| Critique items you accepted (consent, injection, banner, test account, cost, repair, login options) | R9, R12, R15–R19, R22 |
| "make this video like a new feature launch video" | R14 |
| "one page, not separate screens" | Section 1 |

---

## 16. Status at release (v0.3.27)

Built, tested with the local test web app, and driven through the real Electron app in programmatic mode (no AI keys):

| Area | State |
|---|---|
| M0: restrictions engine, private-data detection, blur v2 (shadow DOM, frames, privacy mode), test web app | Done. 17 defects from section 3.1 fixed or covered, except D6 (language check) |
| M1: one page, saved apps, sealed logins, one-time-code hand-off, review, results, launch film with brand kit logo and colour, fallback browser | Done |
| M2: explorer (Quick, Standard, Thorough), beat planner, editable review | Done. Depth limits are the starting values from section 5.1 and have not been tuned on real apps |
| Free engine without AI keys | Done and tested; AI writer and voice follow the plan's rules |

Found only by driving the real app (and fixed): the temporary browser folder could not be deleted on Windows and turned a finished video into a failure; the review panel stayed visible after it was answered; the free-engine wording repeated back-links. Found by the new tests: the username field was not blurred in the recording.

**Added after the release (not yet in an installer):**

- **Reuse the steps (R22).** The steps of the last finished video are kept with the app. "Reuse the steps from the last video" signs in once, runs them quickly to see which still work, finds a moved button again by its name, leaves out a step whose control is gone (and says so), removes a check that no longer holds, and then records. Nothing is explored again. Tested with the test web app and in the real app (recording started after 6 s instead of 13 s).
- **Take over.** While the app is being explored, "Take over" opens a visible window with the same session (cookies are copied across); you open a page or sort something out and press Done. The page you ended on is visited next. Not offered while recording, because the video is being captured. Sessions held only in a page's local storage are not carried across.
- **Look.** Up to three reference pictures colour the backdrop around the browser window and the cards; a reference video's cutting pace picks upbeat or calm music. Read on this computer, never uploaded. The files stay where they are.

**Not built** (honest list):

- **"I'll sign in myself"** opens a real window and is covered by the same hand-off code as the one-time-code test, but the visible-window path itself is not automated.
- **Recordings appear on this page, not in My videos**, with Play and Show in folder (the Footage feature works the same way). Scene-by-scene editing is not offered for them.
- Authenticator-secret storage and the language check (D6).
- **Scope rules** such as "only customer01" are shown as not enforced and force the review, as planned; they are not enforced automatically.
- **Desktop apps** (still waiting for your clarification of the original wording).
