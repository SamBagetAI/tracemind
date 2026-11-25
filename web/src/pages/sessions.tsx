import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { SessionsTable } from "@/components/sessions-table";
import { Empty, Failed, Loading, Page } from "@/components/shell";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApi, type Session } from "@/lib/api";
import { useViewer } from "@/lib/viewer";
import { plural, projectName } from "@/lib/format";
import { useWindow } from "@/lib/window";

const ALL = "__all";

export function SessionsPage() {
  const { days } = useWindow();
  const [params] = useSearchParams();
  // Your own sessions, or the runs of your claude.ai routines.
  const [kind, setKind] = useState(params.get("kind") === "routines" ? "routines" : "sessions");
  const list = useApi<Session[]>(`/sessions?limit=2000&marks=1&days=${days}&kind=${kind}`);
  const me = useViewer();
  const [project, setProject] = useState(ALL);
  const [show, setShow] = useState(params.get("show") ?? "all");
  const [q, setQ] = useState("");

  const projects = useMemo(() => [...new Set((list.data ?? []).map((s) => s.project))].sort((a, b) => projectName(a).localeCompare(projectName(b))), [list.data]);
  const shown = useMemo(
    () =>
      (list.data ?? []).filter(
        (s) =>
          (project === ALL || s.project === project) &&
          (show === "all" || (show === "issues" ? s.issueCount > 0 : s.issueCount === 0)) &&
          (!q || s.title.toLowerCase().includes(q.toLowerCase())),
      ),
    [list.data, project, show, q],
  );
  const people = new Set((list.data ?? []).map((s) => s.person));

  return (
    <Page title={kind === "routines" ? "Routine runs" : "Sessions"} lead={list.data && <span className="text-[13px] num">{plural(list.data.length, kind === "routines" ? "routine run" : "session")} started in the last {days} days</span>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" value={kind} onValueChange={(v) => v && setKind(v)} variant="outline" size="sm" aria-label="Sessions or routine runs">
          <ToggleGroupItem value="sessions" className="h-8 px-3">Your sessions</ToggleGroupItem>
          <ToggleGroupItem value="routines" className="h-8 px-3">Routine runs</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" value={show} onValueChange={(v) => v && setShow(v)} variant="outline" size="sm" aria-label="Which sessions">
          <ToggleGroupItem value="all" className="h-8 px-3">All</ToggleGroupItem>
          <ToggleGroupItem value="issues" className="h-8 px-3">Hit an issue</ToggleGroupItem>
          <ToggleGroupItem value="clean" className="h-8 px-3">Clean</ToggleGroupItem>
        </ToggleGroup>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger size="sm" className="h-8 w-full sm:w-56" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p} value={p}>
                {projectName(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title" className="h-8 w-full sm:ml-auto sm:w-64" aria-label="Filter by title" />
      </div>
      {list.error && <Failed error={list.error} />}
      {!list.data && !list.error && <Loading rows={12} />}
      {list.data && (
        <div>
          {shown.length ? <SessionsTable sessions={shown} showPerson={people.size > 1 || me?.mode === "server"} /> : <Empty>No session matches.</Empty>}
          {shown.length !== list.data.length && (
            <p className="mt-2 text-[12px] text-faint num">
              {shown.length.toLocaleString("en-US")} of {list.data.length.toLocaleString("en-US")} shown
            </p>
          )}
        </div>
      )}
    </Page>
  );
}
