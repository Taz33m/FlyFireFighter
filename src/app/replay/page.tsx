import type { Metadata } from "next";
import { Suspense } from "react";
import { ReplayStage } from "@/components/replay/ReplayStage";

export const metadata: Metadata = {
  title: "Recorded replay · FlyFireFighter",
  description: "A saved FlyFireFighter run bundle played back in the digital twin with the mission phases, timeline and evaluator outcome. Recorded replay, not live inference.",
};

/** Shown while the client reads ?run (useSearchParams needs a Suspense boundary for the static prerender). */
function Loading() {
  return <p className="empty" role="status" style={{ padding: 24 }}>Recorded replay — not live inference. Loading the replay…</p>;
}

export default function ReplayPage() {
  return <Suspense fallback={<Loading />}>
    <ReplayStage />
  </Suspense>;
}
