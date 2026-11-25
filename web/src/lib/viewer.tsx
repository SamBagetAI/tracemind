/**
 * Who is looking and in which mode (local app or server), loaded once for every page under the
 * top bar. Null until it has loaded.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useApi, type Viewer } from "./api";

const Ctx = createContext<Viewer | null>(null);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const me = useApi<Viewer>("/me");
  return <Ctx.Provider value={me.data}>{children}</Ctx.Provider>;
}

export const useViewer = () => useContext(Ctx);
