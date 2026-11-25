/** The top bar, the search palette and the page frame. */
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api, useApi, type Session, type Viewer } from "@/lib/api";
import { projectName, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WINDOWS, useWindow, type Days } from "@/lib/window";

const NAV: [string, string][] = [
  ["/", "Diary"],
  ["/sessions", "Sessions"],
  ["/issues", "Issues"],
  ["/fixes", "Fixes"],
  ["/memory", "Memory"],
  ["/tools", "Tools"],
];


function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (open && !sessions) api<Session[]>("/sessions?limit=500").then(setSessions).catch(() => setSessions([]));
  }, [open, sessions]);
  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Find a session or a page">
      <CommandInput placeholder="Search sessions and pages…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV.map(([to, label]) => (
            <CommandItem key={to} value={`page ${label}`} onSelect={() => go(to)}>
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Sessions">
          {(sessions ?? []).map((s) => (
            <CommandItem key={s.id} value={`${s.title} ${s.project} ${s.id}`} onSelect={() => go(`/sessions/${s.id}`)}>
              <span className="truncate">{s.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-faint">
                {projectName(s.project)} · {when(s.endedAt)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const me = useApi<Viewer>("/me");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { pathname } = useLocation();
  const current = NAV.find(([to]) => (to === "/" ? pathname === "/" : pathname.startsWith(to)))?.[1] ?? "Tracemind";
  const { days, setDays } = useWindow();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm">
        <div className="flex h-11 items-center gap-1 px-3 sm:px-4">
          <NavLink to="/" aria-label="Tracemind" className="mr-1 flex shrink-0 items-center gap-2 font-medium tracking-tight sm:mr-4">
            <img src="/slug.svg" alt="" className="h-8 w-auto" />
            <span className="hidden md:inline">Tracemind</span>
          </NavLink>

          {/* Phones: one menu with every page, so nothing is cut off. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 md:hidden">
                {current} <ChevronDown className="size-3.5 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {NAV.map(([to, label]) => (
                <DropdownMenuItem key={to} asChild>
                  <NavLink to={to} end={to === "/"} className={({ isActive }) => cn(isActive && "bg-accent")}>
                    {label}
                  </NavLink>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <nav className="hidden min-w-0 items-center gap-0.5 md:flex">
            {NAV.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn("shrink-0 rounded-md px-2.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", isActive && "bg-accent text-foreground")
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as Days)}>
              <SelectTrigger size="sm" className="h-7 w-[100px] text-[12px] num" aria-label="Time window for every count">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {WINDOWS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="h-7 gap-2 px-2 text-muted-foreground lg:w-44 lg:justify-start" aria-label="Search">
              <Search className="size-3.5" />
              <span className="hidden lg:inline">Search</span>
              <kbd className="ml-auto hidden rounded border bg-muted px-1 font-mono text-[10px] lg:inline">/</kbd>
            </Button>
            {me.data?.mode === "server" && (
              <form method="post" action="/api/logout">
                <Button variant="ghost" size="sm" className="h-7 text-muted-foreground">
                  Sign out
                </Button>
              </form>
            )}
          </div>
        </div>
      </header>
      <SearchPalette open={open} onOpenChange={setOpen} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** A page with a title row, for every page except the session page. */
/** Every page has the same width, so nothing jumps when moving between them. */
export function Page({ title, lead, actions, children }: { title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 pt-6 pb-16 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
          {lead && <div className="mt-1.5 max-w-[72ch] text-[14px] text-muted-foreground">{lead}</div>}
        </div>
        {actions}
      </div>
      {children}
    </main>
  );
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-muted" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

export function Failed({ error }: { error: string }) {
  return <p className="py-10 text-center text-muted-foreground">Could not load this: {error}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-muted-foreground">{children}</p>;
}
