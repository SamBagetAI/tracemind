/**
 * The one time window every count in the app uses. Chosen in the top bar, remembered in this
 * browser, and shown next to every number as "30d" so no count is read against the wrong window.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

export const WINDOWS = [7, 30, 90] as const;
export type Days = (typeof WINDOWS)[number];

const KEY = "tracemind.window";

function stored(): Days {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (WINDOWS as readonly number[]).includes(v) ? (v as Days) : 30;
  } catch {
    return 30;
  }
}

const Ctx = createContext<{ days: Days; setDays: (d: Days) => void }>({ days: 30, setDays: () => {} });

export function WindowProvider({ children }: { children: ReactNode }) {
  const [days, set] = useState<Days>(stored);
  const setDays = (d: Days) => {
    set(d);
    try {
      localStorage.setItem(KEY, String(d));
    } catch {
      // Private window: the choice lasts for this page only.
    }
  };
  return <Ctx.Provider value={{ days, setDays }}>{children}</Ctx.Provider>;
}

export function useWindow() {
  const { days, setDays } = useContext(Ctx);
  return { days, setDays, label: `${days}d`, phrase: `last ${days} days` };
}
