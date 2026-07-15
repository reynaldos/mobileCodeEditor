# The Elevator Pitch

The one-page version. For the full story, see [ROADMAP.md](ROADMAP.md) (where we are)
and [DECISIONS.md](DECISIONS.md) (why every choice was made).

---

## What it is

**Code from your phone by directing Claude, not by typing.**

You open a web app on your phone, tell Claude what you want ("fix the login bug", "add a
dark mode toggle"), and it does the work in the cloud. When it wants to change a file or run
a command, you get a card showing exactly what it's about to do — you tap **Approve** or
**Reject** with your thumb. When it needs you, your phone buzzes. It commits and pushes to
GitHub as you.

It's **not** VS Code shrunk onto a phone. On a phone you're not writing code line by line —
you're steering an agent and reviewing what it did. So the main screen is a **conversation
with diffs you approve**, not an editor.

---

## What you can do with it

- **Chat with Claude** about your project, and watch it read, edit, and run things.
- **Approve or reject** each change before it happens — every diff, in plain view.
- **Get a push notification** when it's waiting on you, even with your phone in your pocket.
- **Juggle multiple repos and conversations** — clone a repo, switch projects, keep threads.
- **Browse and edit files**, and (soon) open a terminal and preview your app live.

---

## How it's structured

Two pieces, and that's the whole thing.

```
   Your phone (a web app you install like a normal app)
        │
        │   private connection (Tailscale) — nothing is public
        ▼
   One container in the cloud
      • runs Claude
      • holds your code
      • remembers everything in a small database
```

**The phone side** is a website you save to your home screen. It shows the conversation,
the approval cards, and the notifications. It holds no logic of its own — it's a live view
of what's happening in the cloud.

**The cloud side** is a single container (think: one small always-on computer) that holds
your repos, runs Claude, runs your dev servers, and writes down every step in a tiny
database. That database is the memory of the whole system: if the phone disconnects (lock
screen, bad signal, backgrounded), it just reconnects and replays what it missed. If the
server restarts, nothing is lost.

There's no login server, no big database, no separate "backend team" of services. **The
container is the whole backend, and being on your private network is your password.**

---

## Why we built it this way

Every choice traces back to one idea: **a phone is for directing and reviewing, not typing.**
From there:

- **A web app, not a native iPhone app.** The hard parts (editor, terminal, live preview)
  are all web technology anyway, and modern iPhones can send push notifications from a web
  app. Skipping the App Store saves months of cost for a personal tool.

- **One container holds everything.** Claude's tools (read a file, edit it, run a command)
  are just operations on files. Putting Claude *next to* your code makes them work with zero
  plumbing. The alternative — a server that reaches into a remote machine — means rebuilding
  a filesystem over the network, and the project becomes *that* instead of an editor.

- **Write everything down, treat that log as the truth.** Because every step is recorded in
  order, reconnecting after a dropped signal is free, restarting the server is always safe,
  and any future feature ("show me what changed Tuesday") is just a new question asked of the
  same log — never a rewrite.

- **Your private network is the security.** The box lives on your Tailscale network, so only
  your devices can reach it. Nothing is exposed to the public internet, and there's no login
  screen to build for a service only you can touch.

- **Built for one person, on purpose.** One user, many projects, many devices. Supporting
  strangers would be a *different product* — it needs isolation, billing, and account
  systems that would swamp the actual editor. So we deliberately left it out.

The throughline: **keep it small, keep it honest, and never build machinery you don't need
yet.** The simple single-user version we have today is the same shape a bigger version would
grow into — nothing here has to be torn out to grow later.

---

## In one sentence

*A phone-first way to build software by telling Claude what to do and approving its work with
your thumb — powered by one small cloud container that holds your code, runs the agent, and
remembers everything.*
