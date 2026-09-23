import { createRoot, createSignal } from "solid-js";

export type ProcessingJobStatus =
    | "pending"
    | "running"
    | "paused"
    | "retrying"
    | "completed"
    | "failed"
    | "cancelled";

export type ProcessingJobType =
    | "parse_pdf"
    | "ocr_pdf"
    | "generate_thumbnail"
    | "translate_paragraphs"
    | "summarize_paragraphs"
    | "build_paper_summary"
    | "build_embeddings";

export interface ProcessingJob {
    id: string;
    paperId?: string;
    type: ProcessingJobType;
    status: ProcessingJobStatus;
    progress: number;
    errorMessage?: string;
}

const ALLOWED_TRANSITIONS: Record<ProcessingJobStatus, ProcessingJobStatus[]> = {
    pending: ["running", "cancelled"],
    running: ["paused", "completed", "failed", "cancelled"],
    paused: ["pending", "cancelled"],
    retrying: ["running", "failed", "cancelled"],
    completed: [],
    failed: ["retrying"],
    cancelled: [],
};

function createProcessingJobStore() {
    const [jobs, setJobs] = createSignal<ProcessingJob[]>([]);

    function replace(next: ProcessingJob[]) {
        setJobs(next);
    }

    function upsert(job: ProcessingJob) {
        setJobs((current) => {
            const index = current.findIndex((entry) => entry.id === job.id);
            if (index < 0) return [...current, job];
            const next = [...current];
            next[index] = job;
            return next;
        });
    }

    function transition(id: string, status: ProcessingJobStatus) {
        setJobs((current) =>
            current.map((job) => {
                if (job.id !== id) return job;
                if (!ALLOWED_TRANSITIONS[job.status].includes(status)) {
                    throw new Error(
                        `Invalid processing-job transition: ${job.status} -> ${status}`,
                    );
                }
                return { ...job, status };
            }),
        );
    }

    return { jobs, replace, upsert, transition };
}

export const processingJobStore = createRoot(createProcessingJobStore);
