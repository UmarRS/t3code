import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { IssuesBoardPage } from "../components/issues/IssuesBoardPage";

function IssuesRouteView() {
  const { environmentId, projectId } = Route.useParams();
  return (
    <IssuesBoardPage
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
    />
  );
}

export const Route = createFileRoute("/issues/$environmentId/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: IssuesRouteView,
});
