import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentVersion, DocumentVersionReviewState } from "@/app/lib/mikeApi";
import { DocVersionHistory, reviewStateLabel } from "./ProjectPageParts";

const versions: DocumentVersion[] = [
    {
        id: "v1",
        version_number: 1,
        source: "upload",
        created_at: "2026-10-01T10:00:00Z",
        filename: "return-fy2025.pdf",
        review_state: "approved",
    },
    {
        id: "v2",
        version_number: 2,
        source: "assistant_edit",
        created_at: "2026-10-02T10:00:00Z",
        filename: "return-fy2025-v2.pdf",
        review_state: "draft",
    },
    {
        id: "v3",
        version_number: 3,
        source: "upload",
        created_at: "2026-10-03T10:00:00Z",
        filename: "return-fy2025-v3.pdf",
        review_state: "in_review",
    },
];

type OnSetReviewState = (versionId: string, state: DocumentVersionReviewState) => void;

function renderHistory(onSetReviewState?: OnSetReviewState) {
    render(
        <DocVersionHistory
            docId="doc"
            filename="return-fy2025-v3.pdf"
            activeVersionNumber={3}
            currentVersionId="v3"
            loading={false}
            versions={versions}
            onDownloadVersion={vi.fn()}
            onSetReviewState={onSetReviewState}
        />,
    );
}

describe("version review state in the history", () => {
    it("labels approved and in-review versions as plain text and says nothing for a draft", () => {
        expect(reviewStateLabel("approved")).toBe("Approved");
        expect(reviewStateLabel("in_review")).toBe("In review");
        expect(reviewStateLabel("draft")).toBeNull();
        expect(reviewStateLabel(null)).toBeNull();

        renderHistory();
        // The state follows the filename in the same cell, as plain text.
        expect(screen.getByText(/· Approved$/)).toBeInTheDocument();
        // v3 is the current version, which the history leaves to the document row.
        expect(screen.queryByText(/In review/)).not.toBeInTheDocument();
        expect(screen.getByText("return-fy2025-v2.pdf").textContent).toBe(
            "return-fy2025-v2.pdf",
        );
        expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    });

    it("offers the other states from the row menu and reports the chosen one", async () => {
        const onSetReviewState = vi.fn<OnSetReviewState>();
        renderHistory(onSetReviewState);
        const user = userEvent.setup();

        const menus = screen.getAllByRole("button", { name: "Open row actions" });
        // Rows are newest first and the current version is not listed, so the
        // first menu belongs to v2 (a draft).
        await user.click(menus[0]);
        expect(screen.getByText("Send for review")).toBeInTheDocument();
        expect(screen.getByText("Mark approved")).toBeInTheDocument();
        expect(screen.queryByText("Back to draft")).not.toBeInTheDocument();
        await user.click(screen.getByText("Mark approved"));
        expect(onSetReviewState).toHaveBeenCalledWith("v2", "approved");

        await user.click(menus[1]);
        // v1 is approved: it can go back to draft or into review, not be approved again.
        expect(screen.getByText("Back to draft")).toBeInTheDocument();
        expect(screen.queryByText("Mark approved")).not.toBeInTheDocument();
    });

    it("shows no review actions when the caller may not change the state", async () => {
        renderHistory();
        const user = userEvent.setup();
        await user.click(screen.getAllByRole("button", { name: "Open row actions" })[0]);
        expect(screen.queryByText("Send for review")).not.toBeInTheDocument();
        expect(screen.getByText("Download")).toBeInTheDocument();
    });
});
