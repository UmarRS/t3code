# Link a project to another codebase

Work rarely stops at one repository. A backend serves a web app and a mobile app; a frontend calls
an API it does not contain. Link a project to the folders holding those other codebases so Atlas
knows they exist and what they are.

This is different from [scoping a thread to a folder](thread-scope.md), which narrows a single
thread inside one project. Linked projects point outward, at folders in other repositories, and
apply to the whole project.

## Add a link

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Linked projects**, enter the folder path and a description of what the folder is.
4. Select **Add link**.

The description is required, and it is worth writing well: it is what agents read to know what the
linked folder is. "backend for all smartcanvass APIs" tells an agent something; a bare path does
not.

The folder has to exist. It does not have to be a project you have added to Atlas, but whether it
is one decides what agents can do with it:

- A folder that **is** a registered project is marked **agents**. Work can be routed to it.
- A folder that is **not** is marked **context only** — readable, but nothing can be delegated to
  it, because there is no project to open a thread in.

On macOS, Atlas recognizes a registered project even if the typed path uses different letter
casing, such as `/Users/you/dev/api` instead of `/Users/you/Dev/api`. Case-sensitive environments
still require the path's exact casing.

## Delegate work to a linked project

When a link is marked **agents**, an agent working in this project can hand that repository a task.
It opens a thread there, runs an agent with the same model and the same write access, and reports
the result back into the conversation that asked for it — so a single request can build a UI here
and the endpoints it calls over there.

Three tools drive this, and the agent chooses when to use them:

| Tool                         | What it does                           |
| ---------------------------- | -------------------------------------- |
| `list_linked_projects`       | Lists the links and which are routable |
| `delegate_to_linked_project` | Hands over a task and waits for it     |
| `check_linked_project_agent` | Polls a task still running             |

The delegated agent runs in its own repository and **cannot see your conversation**, so the task it
receives has to stand alone. Delegating to the same project twice continues the same agent's
thread rather than starting a stranger.

A long task comes back as _still working_ rather than blocking; the agent polls it and picks the
result up later. Its thread does not appear in the sidebar on its own — it belongs to the
conversation that created it, and is reachable from the delegation row in that thread.

Two things stay single-repository by design: **diffs and git actions**. The parent thread's diff
shows only the parent's repository; the delegated agent's changes live on its own thread, and are
committed from there.

## Links go both ways

When the folder you link is a project you have already added, that project shows the link too,
marked **mirrored**, pointing back at the project that made it. There is only ever one link behind
both views, so removing it from either side removes it for both.

## Remove a link

Select the trash icon next to the link. Removing a mirrored link removes the original.
