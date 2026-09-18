import type { QueryClient } from "@tanstack/react-query";
import type {
  ProjectResponse,
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
  ThreadResponse,
  ThreadWithIncludesResponse,
} from "@bb/server-contract";
import {
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  threadHistoryQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { invalidateProjectDeleteQueries } from "./mutation-cache-effects";
import { getCachedSidebarNavigationThreads } from "./query-cache";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import { removeThreadHistory } from "./thread-history-cache-owner";

interface ApplyProjectCreateResultArgs {
  project: ProjectResponse;
  queryClient: QueryClient;
}

interface ApplyProjectDeleteResultArgs {
  projectId: string;
  queryClient: QueryClient;
}

function removeProjectFromProjectList(
  currentProjects: readonly ProjectResponse[],
  projectId: string,
): ProjectResponse[] {
  return currentProjects.filter((project) => project.id !== projectId);
}

function removeProjectFromSidebarNavigation(
  currentNavigation: SidebarBootstrapResponse,
  projectId: string,
): SidebarBootstrapResponse {
  return {
    ...currentNavigation,
    projects: currentNavigation.projects.filter(
      (project) => project.id !== projectId,
    ),
  };
}

function projectToSidebarProject(
  project: ProjectResponse,
): ProjectWithThreadsResponse {
  return {
    ...project,
    threads: [],
    defaultExecutionOptions: null,
  };
}

function applyProjectToProjectList(
  currentProjects: readonly ProjectResponse[],
  project: ProjectResponse,
): ProjectResponse[] {
  if (
    !currentProjects.some((currentProject) => currentProject.id === project.id)
  ) {
    return [...currentProjects, project];
  }

  return currentProjects.map((currentProject) =>
    currentProject.id === project.id ? project : currentProject,
  );
}

function applyProjectToSidebarNavigation(
  currentNavigation: SidebarBootstrapResponse,
  project: ProjectResponse,
): SidebarBootstrapResponse {
  if (currentNavigation.personalProject.id === project.id) {
    return {
      ...currentNavigation,
      personalProject: {
        ...currentNavigation.personalProject,
        ...project,
      },
    };
  }

  const existingProject = currentNavigation.projects.find(
    (currentProject) => currentProject.id === project.id,
  );
  if (!existingProject) {
    return {
      ...currentNavigation,
      projects: [
        ...currentNavigation.projects,
        projectToSidebarProject(project),
      ],
    };
  }

  return {
    ...currentNavigation,
    projects: currentNavigation.projects.map((currentProject) =>
      currentProject.id === project.id
        ? {
            ...currentProject,
            ...project,
          }
        : currentProject,
    ),
  };
}

export function applyProjectCreateResult({
  project,
  queryClient,
}: ApplyProjectCreateResultArgs): void {
  queryClient.setQueryData<ProjectResponse[]>(
    projectsQueryKey(),
    (currentProjects) =>
      currentProjects
        ? applyProjectToProjectList(currentProjects, project)
        : [project],
  );
  queryClient.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
    (currentNavigation) =>
      currentNavigation
        ? applyProjectToSidebarNavigation(currentNavigation, project)
        : currentNavigation,
  );
}

export function applyProjectDeleteResult({
  projectId,
  queryClient,
}: ApplyProjectDeleteResultArgs): void {
  removeProjectThreadHistory({ projectId, queryClient });
  queryClient.setQueryData<ProjectResponse[]>(
    projectsQueryKey(),
    (currentProjects) =>
      currentProjects
        ? removeProjectFromProjectList(currentProjects, projectId)
        : currentProjects,
  );
  queryClient.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
    (currentNavigation) =>
      currentNavigation
        ? removeProjectFromSidebarNavigation(currentNavigation, projectId)
        : currentNavigation,
  );
  invalidateProjectDeleteQueries({ queryClient });
}

export function collectCachedThreadIdsForProject({
  projectId,
  queryClient,
}: ApplyProjectDeleteResultArgs): string[] {
  const cachedHistoryIds = new Set(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: threadHistoryQueryKeyPrefix() })
      .map((query) => query.queryKey[1]),
  );
  const ids = new Set<string>();
  for (const queryKey of [
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
  ]) {
    for (const [, thread] of queryClient.getQueriesData<
      ThreadResponse | ThreadWithIncludesResponse
    >({ queryKey })) {
      if (thread?.projectId === projectId) ids.add(thread.id);
    }
  }
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.projectId === projectId) ids.add(thread.id);
    }
  }
  for (const thread of getCachedSidebarNavigationThreads(queryClient)) {
    if (thread.projectId === projectId) ids.add(thread.id);
  }
  return [...ids].filter((id) => cachedHistoryIds.has(id));
}

export function removeProjectThreadHistory(
  args: ApplyProjectDeleteResultArgs,
): void {
  for (const threadId of collectCachedThreadIdsForProject(args)) {
    removeThreadHistory({ queryClient: args.queryClient, threadId });
  }
}
