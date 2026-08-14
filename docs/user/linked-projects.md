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

The folder has to exist. It does not have to be a project you have added to Atlas — a folder that
is not a project is marked **context only**, and works as read-only context and nothing more.

## Links go both ways

When the folder you link is a project you have already added, that project shows the link too,
marked **mirrored**, pointing back at the project that made it. There is only ever one link behind
both views, so removing it from either side removes it for both.

## Remove a link

Select the trash icon next to the link. Removing a mirrored link removes the original.
