import { createFileRoute, redirect } from "@tanstack/react-router";

import { IssuesOverviewPage } from "../components/issues/IssuesOverviewPage";

export const Route = createFileRoute("/issues_")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: IssuesOverviewPage,
});
