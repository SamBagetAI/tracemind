import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Server mode only. The form posts to /api/login, which sets an http-only cookie. */
export function LoginPage() {
  const [params] = useSearchParams();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4">
      <h1 className="text-[22px] font-semibold tracking-tight">Sign in to Tracemind</h1>
      <p className="mt-1.5 mb-5 text-muted-foreground">Use the token your workspace admin gave you.</p>
      <form method="post" action="/api/login" className="grid gap-2">
        <Input type="password" name="token" placeholder="tm_…" autoComplete="current-password" required aria-label="Token" className="h-9 font-mono" />
        {params.get("error") && <p className="text-fail">That token is not valid.</p>}
        <Button type="submit" className="h-9">Sign in</Button>
      </form>
    </main>
  );
}
