import { Empty, Failed, Loading, Page } from "@/components/shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, type Tool } from "@/lib/api";
import { LEVEL_CLASS, duration, num, percent, rateLevel, toolLabel } from "@/lib/format";
import { FEW, rankTools } from "@/lib/rank";
import { useWindow } from "@/lib/window";


/** The finding, in one sentence: which tool fails most often, and how many never failed. */
function toolsLead(sorted: Tool[], days: number): string {
  const top = sorted.find((t) => t.errors > 0 && t.calls >= FEW);
  const clean = sorted.filter((t) => t.errors === 0).length;
  const head = top
    ? `${sorted.filter((t) => toolLabel(t.name) === toolLabel(top.name)).length > 1 ? top.name : toolLabel(top.name)} fails most often: ${num(top.errors)} of ${num(top.calls)} calls (${percent(top.errors / top.calls)}) in the last ${days} days.`
    : `No tool with ${FEW}+ calls failed in the last ${days} days.`;
  return `${head} ${clean} of ${sorted.length} tools never failed.`;
}

export function ToolsPage() {
  const { days } = useWindow();
  const tools = useApi<Tool[]>(`/tools?days=${days}`);
  const sorted = rankTools(tools.data ?? []);
  return (
    <Page title="Tools" lead={tools.data && tools.data.length > 0 && <span className="text-[13px] num">{toolsLead(sorted, days)}</span>}>
      {tools.error && <Failed error={tools.error} />}
      {!tools.data && !tools.error && <Loading rows={12} />}
      {tools.data && tools.data.length === 0 && <Empty>No tool calls in the last {days} days.</Empty>}
      {tools.data && tools.data.length > 0 && (
        <div>
          <p className="mb-2 text-[12px] text-muted-foreground">
            Red from 10% failed. Under {FEW} calls a rate is too unsure to rank, so those tools come after. Times leave out waits for you.
          </p>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tool</TableHead>
                <TableHead className="w-16 text-right sm:w-20">Calls</TableHead>
                <TableHead className="hidden w-20 text-right sm:table-cell">Failed</TableHead>
                <TableHead className="w-24 text-right sm:w-28">% failed</TableHead>
                <TableHead className="hidden w-24 text-right sm:table-cell">Median time</TableHead>
                <TableHead className="hidden w-24 text-right sm:table-cell">Slowest 5%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((t) => {
                const rate = t.calls ? t.errors / t.calls : 0;
                const few = t.calls < FEW;
                const [server, name] = t.name.includes("/") ? [t.name.split("/").slice(0, -1).join("/"), t.name.split("/").pop()!] : ["", t.name];
                return (
                  <TableRow key={t.name}>
                    <TableCell className="truncate py-2" title={t.name}>
                      <span className="font-mono text-[12px] text-foreground">{name}</span>
                      {server && <span className="font-mono text-[11px] text-faint"> · {server}</span>}
                    </TableCell>
                    <TableCell className="text-right text-[12px] text-muted-foreground num">{num(t.calls)}</TableCell>
                    <TableCell className="hidden text-right text-[12px] num sm:table-cell">
                      {t.errors > 0 && <span className="text-foreground">{num(t.errors)}</span>}
                    </TableCell>
                    <TableCell className="text-right text-[12px] num">
                      {t.errors === 0 ? null : (
                        <span className="inline-flex items-center justify-end gap-1.5">
                          {few && <span className="text-[11px] text-faint">few calls,</span>}
                          <span className={few ? "text-muted-foreground" : LEVEL_CLASS[rateLevel(rate)]}>{percent(rate)}</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-right text-[12px] text-muted-foreground num sm:table-cell">{duration(t.typicalMs)}</TableCell>
                    <TableCell className="hidden text-right text-[12px] text-muted-foreground num sm:table-cell">{duration(t.slowMs)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}
