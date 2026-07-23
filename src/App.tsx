import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/AuthContext";
import { DatetimePrefsProvider } from "@/contexts/DatetimePrefsContext";
import Index from "./pages/Index";
import Login from "./pages/Login";
import AppPage from "./pages/App";
import ReportView from "./pages/ReportView";
import Settings from "./pages/Settings";
import SqlEditor from "./pages/SqlEditor";
import NotFound from "./pages/NotFound";
import LineChartTest from "./pages/LineChartTest";
import CompositeReportView from "./pages/CompositeReportView";
import CompositeReportEditor from "./pages/CompositeReportEditor";
import AiChat from "./pages/AiChat";

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="light"
      enableSystem={false}
    >
      <TooltipProvider>
        <Sonner />
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <AuthProvider>
            <DatetimePrefsProvider>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/login" element={<Login />} />
                <Route path="/app" element={<AppPage />} />
                <Route path="/app/report/:reportId" element={<ReportView />} />
                <Route path="/app/settings" element={<Settings />} />
                <Route path="/app/sql-editor" element={<SqlEditor />} />
                <Route path="/app/chat" element={<AiChat />} />
                <Route
                  path="/app/composite-report/:id"
                  element={<CompositeReportView />}
                />
                <Route
                  path="/app/composite-report/new"
                  element={<CompositeReportEditor />}
                />
                <Route
                  path="/app/composite-report/:id/edit"
                  element={<CompositeReportEditor />}
                />
                <Route path="/test/line-chart" element={<LineChartTest />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </DatetimePrefsProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
