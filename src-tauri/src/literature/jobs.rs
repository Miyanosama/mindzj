use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingJobType {
    ParsePdf,
    OcrPdf,
    GenerateThumbnail,
    TranslateParagraphs,
    SummarizeParagraphs,
    BuildPaperSummary,
    BuildEmbeddings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingJobStatus {
    Pending,
    Running,
    Paused,
    Retrying,
    Completed,
    Failed,
    Cancelled,
}

impl ProcessingJobStatus {
    pub fn can_transition_to(&self, next: &Self) -> bool {
        use ProcessingJobStatus::*;
        matches!(
            (self, next),
            (Pending, Running)
                | (Pending, Cancelled)
                | (Running, Paused)
                | (Running, Completed)
                | (Running, Failed)
                | (Running, Cancelled)
                | (Paused, Pending)
                | (Paused, Cancelled)
                | (Failed, Retrying)
                | (Retrying, Running)
                | (Retrying, Failed)
                | (Retrying, Cancelled)
        )
    }
}
