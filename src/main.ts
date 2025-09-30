import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Vault, normalizePath } from 'obsidian';
import { dump } from 'js-yaml';

// View type constant
const LECTURE_COPILOT_VIEW_TYPE = "lecture-copilot-view";

// Remember to rename these classes and interfaces!

interface LectureCopilotSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: LectureCopilotSettings = {
	mySetting: 'default'
}

export default class LectureCopilot extends Plugin {
	settings: LectureCopilotSettings;

	async onload() {
		await this.loadSettings();

		// Register the view
		this.registerView(
			LECTURE_COPILOT_VIEW_TYPE,
			(leaf) => new LectureCopilotView(leaf)
		);

		// Add ribbon icon that opens the side panel
		this.addRibbonIcon('dice', 'Open Lecture Copilot', () => {
			this.activateView();
		});
	}

	onunload() {
		// Clean up - detach the view
		this.app.workspace.detachLeavesOfType(LECTURE_COPILOT_VIEW_TYPE);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LECTURE_COPILOT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({ type: LECTURE_COPILOT_VIEW_TYPE, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LectureCopilotView extends ItemView {
	private recorder: AudioRecorder;
	private transcriptionEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.recorder = new AudioRecorder();
	}

	getViewType() {
		return LECTURE_COPILOT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Lecture Copilot';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl("h4", { text: "Lecture Copilot" });
		container.createEl('br');
		// Create Start and Stop buttons
		const startButton = container.createEl("button", { text: "Start Recording" });
		const stopButton = container.createEl("button", { text: "Stop Recording" });
		stopButton.hide();

		container.createEl('h5', { text: 'Transcription:', });
		this.transcriptionEl = container.createEl('div', {
			text: '',
			cls: 'lecture-copilot-transcript'
		});

		// Set up the live update callback
		this.recorder.onTranscriptUpdate = (transcript: string) => {
			if (this.transcriptionEl) {
				// Split into paragraphs for better readability
				const paragraphs = transcript.split('\n\n').filter(p => p.trim());
				this.transcriptionEl.empty();

				paragraphs.forEach((paragraph, index) => {
					const p = this.transcriptionEl!.createEl('p');
					p.textContent = paragraph;

					// Highlight the current (incomplete) turn
					if (index === paragraphs.length - 1 && this.recorder.getCurrentTurn().trim()) {
						p.addClass('current-turn');
					}
				});

				// Auto-scroll to bottom
				this.transcriptionEl.scrollTop = this.transcriptionEl.scrollHeight;
			}
		};

		startButton.addEventListener("click", async () => {
			try {
				this.recorder.clearTranscript(); // Clear previous transcript
				await this.recorder.startRecording();
				new Notice("Recording started!");
				startButton.hide();
				stopButton.show();
			} catch (error) {
				new Notice("Failed to start recording: " + error.message);
				console.log(error.message);
			}
		});

		stopButton.addEventListener("click", async () => {
			try {
				await this.transcriptToFile();

			} catch (error) {
				new Notice("Failed to stop recording: " + (error instanceof Error ? error.message : String(error)));
				console.log(error);
			}
			stopButton.hide();
			startButton.show();
		});
	}

	async onClose() {

	}

	// Save the current transcript to a file in the vault and update active note's frontmatter
	async transcriptToFile() {
		// Capture the current active leaf/view/file BEFORE doing anything that may steal focus
		const prevActiveLeaf = this.app.workspace.activeLeaf;
		const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
		const prevMarkdownView = mostRecentLeaf?.view instanceof MarkdownView ? (mostRecentLeaf.view as MarkdownView) : null;
		const activeFileAtStart = prevMarkdownView?.file ?? this.app.workspace.getActiveFile();

		try {
			const transcript = await this.recorder.stopRecording();
			new Notice("Recording stopped!");

			// If no file to attach to, still save transcript to vault root
			if (!activeFileAtStart) {
				new Notice("No active note to attach transcript to. Saving transcript to vault root.");
			}

			// Build transcript filename next to the active file (or root)
			const now = new Date();
			const timestamp = `${now.getDay()}-${now.getMonth() + 1}`
			const transcriptBasename = activeFileAtStart ? `${activeFileAtStart.basename}-transcript-${timestamp}.md` : `transcript-${timestamp}.md`;
			const folder = activeFileAtStart ? activeFileAtStart.path.replace(/\/[^/]+$/, '') : '';
			const filePath = folder ? `${folder}/${transcriptBasename}` : transcriptBasename;
			const normalized = normalizePath(filePath);
			const fileContent = `# Transcript\n\n${transcript}`;

			// If there is an active note file, update its frontmatter with a transcript link
			if (activeFileAtStart) {
				try {
					const cache = this.app.metadataCache.getFileCache(activeFileAtStart);
					const oldContent = await this.app.vault.read(activeFileAtStart);
					const newProps = Object.assign({}, cache?.frontmatter, { transcript: `[[${transcriptBasename.replace(/\.md$/, '')}]]` });

					// Use js-yaml to serialize the frontmatter, then unquote wiki-links like [[Page]]
					let yaml = dump(newProps, { lineWidth: -1 });

					// Remove unnecessary quotes around wiki-links that js-yaml may have added
					yaml = yaml.replace(/"(\[\[[^\]]+\]\])"/g, '$1');

					const fmMatch = oldContent.match(/^---\n([\s\S]*?)\n---\n?/);
					let newContent: string;
					if (fmMatch) {
						newContent = `---\n${yaml}\n---\n` + oldContent.slice(fmMatch[0].length);
					} else {
						newContent = `---\n${yaml}\n---\n\n` + oldContent;
					}

					await this.app.vault.modify(activeFileAtStart, newContent);
				} catch (err) {
					console.error("Failed to update active file frontmatter:", err);
					new Notice("Failed to update active note with transcript link.");
				}
			}

			// Create the transcript file
			await this.app.vault.create(normalized, fileContent);
			new Notice(`Transcript saved to ${transcriptBasename}`);

			// Open the transcript in a split leaf (may steal focus)...
			const newLeaf = this.app.workspace.getLeaf('split');
			const fileObj = this.app.vault.getAbstractFileByPath(normalized);
			if (fileObj) {
				await newLeaf.openFile(fileObj as any);
			}

			// ...then restore the previously active leaf and editor focus so the editor remains active
			if (prevActiveLeaf) {
				try {
				} catch (e) {
					// Fallback: reveal the previous leaf
					this.app.workspace.revealLeaf(prevActiveLeaf);
				}
			}
			if (prevMarkdownView?.editor?.focus) {
				try { prevMarkdownView.editor.focus(); } catch (e) { /* ignore */ }
			}
		} catch (error) {
			console.error("Error during transcript to file:", error);
			new Notice("Error saving transcript: " + (error instanceof Error ? error.message : String(error)));
		}
	}

}

export class AudioRecorder {
	private audioContext: AudioContext | null = null;
	private scriptNode: ScriptProcessorNode | null = null;
	private mediaStream: MediaStream | null = null;
	private ws: WebSocket | null = null;
	private AssemblyAPIKey: string = 'bec2bf1d1a7a479da052826f69a65b14';

	// Separate transcript management
	private completedTurns: string[] = []; // Finalized turns
	private currentTurn: string = ''; // Live updating current turn
	private currentTurnOrder: number = -1; // Track which turn we're on

	// Callback for live updates
	public onTranscriptUpdate: ((fullTranscript: string) => void) | null = null;

	async startRecording() {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error("Audio Recording is not supported on this device.");
		}
		this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		this.audioContext = new AudioContext({ sampleRate: 16000 });
		const source = this.audioContext.createMediaStreamSource(this.mediaStream);
		this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);

		this.ws = await this.initAssemblyAIWebSocket();

		// Set up the WebSocket message handler
		this.setupWebSocketHandlers();

		this.scriptNode.onaudioprocess = (audioProcessingEvent) => {
			const inputBuffer = audioProcessingEvent.inputBuffer;
			const inputData = inputBuffer.getChannelData(0);
			const pcmBuffer = this.floatTo16BitPCM(inputData);
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.ws.send(pcmBuffer);
			}
		};

		source.connect(this.scriptNode);
		this.scriptNode.connect(this.audioContext.destination);
		console.log("Recording started (PCM streaming).");
	}

	async stopRecording() {
		if (this.scriptNode) {
			this.scriptNode.disconnect();
			this.scriptNode.onaudioprocess = null;
			this.scriptNode = null;
		}
		if (this.audioContext) {
			await this.audioContext.close();
			this.audioContext = null;
		}
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach(track => track.stop());
			this.mediaStream = null;
		}
		console.log("Recording stopped.");

		if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState as 0 | 1)) {
			console.log("Closing WebSocket connection.");
			const terminateMessage = { type: "Terminate" }
			this.ws.send(JSON.stringify(terminateMessage));
			this.ws.close();
		}

		// Finalize any remaining current turn
		const transcript = this.getFullTranscript();
		return transcript;


	}

	private async initAssemblyAIWebSocket(): Promise<WebSocket> {
		const apiUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&formatTurns=true&token=${encodeURIComponent(this.AssemblyAPIKey)}`;
		const ws = new WebSocket(apiUrl);

		return new Promise((resolve, reject) => {
			ws.onopen = () => {
				console.log("WebSocket connection opened");
				resolve(ws);
			};
			ws.onerror = (error) => {
				reject(new Error("WebSocket connection error: " + error));
			}
		});


	}

	private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
		const buffer = new ArrayBuffer(input.length * 2);
		const view = new DataView(buffer);
		for (let i = 0; i < input.length; i++) {
			let s = Math.max(-1, Math.min(1, input[i]));
			view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // little-endian
		}
		return buffer;
	}

	private setupWebSocketHandlers() {
		if (!this.ws) return;

		this.ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);
				console.log("Received message:", message);

				if (message.type === "Turn") {
					this.handleTurnMessage(message);
				}
			} catch (error) {
				console.error("Error parsing WebSocket message:", error);
			}
		};
	}

	private handleTurnMessage(message: AssemblyAIWebSocketMessage): void {
		// Check if we're starting a new turn
		if (message.turn_order !== this.currentTurnOrder) {
			// New turn started - finalize the previous one if it exists
			if (this.currentTurnOrder >= 0 && this.currentTurn.trim()) {
				this.completedTurns.push(this.currentTurn.trim());
			}

			// Start tracking the new turn
			this.currentTurnOrder = message.turn_order;
			this.currentTurn = message.transcript || '';
		} else {
			// Update the current turn with new transcript
			this.currentTurn = message.transcript || '';
		}

		// If this turn is complete, finalize it
		if (message.end_of_turn) {
			if (this.currentTurn.trim()) {
				this.completedTurns.push(this.currentTurn.trim());
			}
			this.currentTurn = '';
			this.currentTurnOrder = -1;
		}

		// Trigger live update
		this.updateLiveTranscript();
	}

	private updateLiveTranscript(): void {
		// Combine completed turns with current live turn
		const fullTranscript = [
			...this.completedTurns,
			...(this.currentTurn.trim() ? [this.currentTurn] : [])
		].join('\n\n');

		if (this.onTranscriptUpdate) {
			this.onTranscriptUpdate(fullTranscript);
		}
	}

	// Public method to get the full transcript at any time
	public getFullTranscript(): string {
		return [
			...this.completedTurns,
			...(this.currentTurn.trim() ? [this.currentTurn] : [])
		].join('\n\n');
	}

	// Public method to get the current turn
	public getCurrentTurn(): string {
		return this.currentTurn;
	}

	// Clear transcript (useful for new recordings)
	public clearTranscript(): void {
		this.completedTurns = [];
		this.currentTurn = '';
		this.currentTurnOrder = -1;
		this.updateLiveTranscript();
	}
}

type AssemblyAIWebSocketMessage = {
	type: 'Turn',
	turn_order: number,
	turn_is_formatted: boolean,
	end_of_turn: boolean,
	transcript: string // all the final words in a turn
}

// Move transcriptToFile to be an instance method on LectureCopilotView to correctly access this.recorder and this.app