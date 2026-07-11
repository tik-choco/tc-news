// Subscribes a component to the global AI job queue (lib/jobQueue) so it
// re-renders whenever a job is enqueued, progresses, or finishes.
// getJobs() returns a cached snapshot whose reference only changes on an
// actual state change, so a plain setState(getJobs()) on every
// notification is safe and never causes redundant re-renders.
import { useEffect, useState } from "preact/hooks";
import { getJobs, subscribeJobQueue, type JobInfo } from "../lib/jobQueue";

export function useJobQueue(): JobInfo[] {
  const [jobs, setJobs] = useState<JobInfo[]>(() => getJobs());

  useEffect(() => {
    // Snapshot may have changed between the initial useState() call and this
    // effect running (mount race), so sync once before subscribing.
    setJobs(getJobs());
    return subscribeJobQueue(() => {
      setJobs(getJobs());
    });
  }, []);

  return jobs;
}
