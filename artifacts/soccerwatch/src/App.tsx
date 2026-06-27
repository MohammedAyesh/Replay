import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { Layout } from "@/components/layout";

import Login from "@/pages/login";
import Watch from "@/pages/watch";
import Fields from "@/pages/fields";
import FieldDetail from "@/pages/field-detail";
import Player from "@/pages/player";
import OSSPlayer from "@/pages/oss-player";
import MyClips from "@/pages/my-clips";
import Account from "@/pages/account";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Login} />
        <Route path="/watch" component={Watch} />
        <Route path="/fields" component={Fields} />
        <Route path="/fields/:camera" component={FieldDetail} />
        <Route path="/player/:id" component={Player} />
        <Route path="/oss-player" component={OSSPlayer} />
        <Route path="/my-clips" component={MyClips} />
        <Route path="/account" component={Account} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
