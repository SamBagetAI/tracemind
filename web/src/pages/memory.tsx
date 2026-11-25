/**
 * What agents knew in the window: the instruction files loaded at the start, the files read or
 * written, the skills and memory tools used, with how often. Plain counts: how a file relates to
 * sessions going wrong is not shown, since long sessions load more files and hit more issues alike.
 */
import { SectionTitle } from "@/components/marks";
import { Empty, Failed, Loading, Page } from "@/components/shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, type MemoryRow } from "@/lib/api";
import { memoryLabel, num, plural, when } from "@/lib/format";
import { useWindow } from "@/lib/window";

const SOURCES: [string, string][] = [
  ["instructions", "Loaded at session start"],
  ["file", "Read or written by the agent"],
  ["skill", "Skills used"],
  ["mcp", "Memory tools used"],
];

/** The finding: what was loaded or used most, in one sentence. */
function lead(rows: MemoryRow[], days: number): string {
  const top = [...rows].sort((a, b) => b.sessions - a.sessions)[0];
  const written = rows.filter((r) => r.writes > 0).length;
  return `${memoryLabel(top).name} was used most: in ${plural(top.sessions, "session")} in the last ${days} days. ${plural(written, "file was", "files were")} written.`;
}

export function MemoryPage() {
  const { days } = useWindow();
  const rows = useApi<MemoryRow[]>(`/memory?days=${days}`);

  return (
    <Page title="Memory" lead={rows.data && rows.data.length > 0 && <span className="text-[13px] num">{lead(rows.data, days)}</span>}>
      {rows.error && <Failed error={rows.error} />}
      {!rows.data && !rows.error && <Loading rows={12} />}
      {rows.data && rows.data.length === 0 && <Empty>No instructions, skills or memory recorded in the last {days} days.</Empty>}
      {rows.data && rows.data.length > 0 && (
        <div className="space-y-10">
          {SOURCES.map(([source, title]) => {
            const list = rows.data!.filter((r) => r.source === source);
            if (!list.length) return null;
            const paths = source === "instructions" || source === "file";
            return (
              <section key={source}>
                <SectionTitle aside={<span className="text-[12px] text-faint num">{list.length}</span>}>{title}</SectionTitle>
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{paths ? "File" : "Name"}</TableHead>
                      <TableHead className="w-24 text-right">Sessions</TableHead>
                      {source === "file" && <TableHead className="hidden w-20 text-right sm:table-cell">Reads</TableHead>}
                      {source === "file" && <TableHead className="hidden w-20 text-right sm:table-cell">Writes</TableHead>}
                      <TableHead className="w-24 text-right">Last used</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((m) => {
                      const { name, folder } = memoryLabel(m);
                      return (
                        <TableRow key={`${m.source}:${m.ref}`}>
                          <TableCell className="py-2" title={m.ref}>
                            <span className="block truncate font-mono text-[12px] text-foreground">{name}</span>
                            {folder && <span className="block truncate font-mono text-[11px] text-muted-foreground">{folder}</span>}
                          </TableCell>
                          <TableCell className="text-right text-[13px] num">{num(m.sessions)}</TableCell>
                          {source === "file" && <TableCell className="hidden text-right text-[12px] text-muted-foreground num sm:table-cell">{m.reads || ""}</TableCell>}
                          {source === "file" && <TableCell className="hidden text-right text-[12px] num sm:table-cell">{m.writes ? <span className="text-ok">{m.writes}</span> : ""}</TableCell>}
                          <TableCell className="text-right text-[12px] text-muted-foreground num">{when(m.lastAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </section>
            );
          })}
        </div>
      )}
    </Page>
  );
}
