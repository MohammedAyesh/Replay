import { HomeHubRedesigned } from "@/components/match/HomeHubRedesigned";

export default function Home() {
  return (
    <div className="home-page relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="home-page-scroll min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <HomeHubRedesigned />
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[150px] bg-gradient-to-b from-transparent via-background/75 to-background" />
    </div>
  );
}
