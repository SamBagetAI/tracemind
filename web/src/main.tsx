import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, Navigate } from "react-router";
import { Empty, Page, Shell } from "@/components/shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IssuePage } from "@/pages/issue";
import { IssuesPage } from "@/pages/issues";
import { LoginPage } from "@/pages/login";
import { MemoryPage } from "@/pages/memory";
import { DiaryPage } from "@/pages/diary";
import { SessionPage } from "@/pages/session";
import { SessionsPage } from "@/pages/sessions";
import { SuggestionsPage } from "@/pages/suggestions";
import { ToolsPage } from "@/pages/tools";
import { WindowProvider } from "@/lib/window";
import "./index.css";

function App() {
  return (
    <BrowserRouter>
      <WindowProvider>
      <TooltipProvider delayDuration={150}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="*"
            element={
              <Shell>
                <Routes>
                  <Route path="/" element={<DiaryPage />} />
                  <Route path="/sessions" element={<SessionsPage />} />
                  <Route path="/sessions/:id" element={<SessionPage />} />
                  <Route path="/issues" element={<IssuesPage />} />
                  <Route path="/issues/:key" element={<IssuePage />} />
                  <Route path="/fixes" element={<SuggestionsPage />} />
                  <Route path="/suggestions" element={<Navigate to="/fixes" replace />} />
                  <Route path="/memory" element={<MemoryPage />} />
                  <Route path="/tools" element={<ToolsPage />} />
                  <Route path="*" element={<Page title="Not found"><Empty>There is no page here.</Empty></Page>} />
                </Routes>
              </Shell>
            }
          />
        </Routes>
        <Toaster position="bottom-right" />
      </TooltipProvider>
      </WindowProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
