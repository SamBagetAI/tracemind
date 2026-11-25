import { Link } from "react-router";
import { Clean, FailureStrip } from "@/components/marks";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Session } from "@/lib/api";
import { fullDate, num, projectName, when } from "@/lib/format";

/**
 * Sessions as a table. Each row shows where along the session its tool calls failed, as the strip
 * on the session's own page does, with the count; a clean session gets a quiet tick instead.
 */
export function SessionsTable({ sessions, showPerson }: { sessions: Session[]; showPerson?: boolean }) {
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Session</TableHead>
          {showPerson && <TableHead className="hidden w-32 md:table-cell">Person</TableHead>}
          <TableHead className="w-[136px]">Where it failed</TableHead>
          <TableHead className="hidden w-16 text-right sm:table-cell">Steps</TableHead>
          <TableHead className="w-[72px] text-right">Ended</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((s) => {
          return (
            <TableRow key={s.id} className="group">
              <TableCell className="py-2 whitespace-normal">
                <Link to={`/sessions/${s.id}`} className="line-clamp-2 text-foreground decoration-faint underline-offset-2 group-hover:underline sm:line-clamp-1">
                  {s.title}
                </Link>
                <span className="mt-0.5 block truncate text-[12px] text-faint">
                  {projectName(s.project)}
                  {s.gitBranch && <> · <span className="font-mono text-[11px]">{s.gitBranch}</span></>}
                </span>
              </TableCell>
              {showPerson && <TableCell className="hidden truncate md:table-cell">{s.person}</TableCell>}
              <TableCell>
                <span className="flex h-5 items-center gap-2">
                  {s.toolErrors || s.marks?.length ? <FailureStrip marks={s.marks ?? []} count={s.toolErrors} /> : <Clean />}
                </span>
              </TableCell>
              <TableCell className="hidden text-right text-[12px] text-muted-foreground num sm:table-cell">{num(s.stepCount)}</TableCell>
              <TableCell className="text-right text-[12px] text-muted-foreground num" title={fullDate(s.endedAt)}>
                {when(s.endedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
