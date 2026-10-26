import { Header } from "@/components/header";
import { DiceViewer } from "@/components/dice-viewer";

export default function Home() {
  return (
    <div className="relative w-screen h-dvh overflow-hidden flex flex-col bg-stone-100 text-stone-900">
      {/* 頂部導航列 */}
      <Header />

      {/* 主內容區：全畫面 3D 俯視畫布 */}
      <main className="relative flex-1 w-full h-full overflow-hidden">
        <DiceViewer />
      </main>
    </div>
  );
}