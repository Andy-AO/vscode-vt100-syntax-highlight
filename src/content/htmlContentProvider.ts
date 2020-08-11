import * as vscode from 'vscode';

import { randomBytes } from 'crypto';

import { ConfigurationManager } from '../configurationManager';
import { VT100Parser } from '../vt100Parser';

export class HTMLContentProvider implements vscode.Disposable {

	static generateKeyMappings(): Map<string, string> {
		const map: Map<string, string> = new Map();

		map.set('foreground', 'fg');
		map.set('background', 'bg');
		map.set('text', 'te');
		map.set('escape-sequence', 'es');

		for (const [color, abbreviation] of [
			[ 'default', 'de' ],
			[ 'inverted', 'in' ],
			[ 'black', 'bl' ],
			[ 'red', 're' ],
			[ 'green', 'gr' ],
			[ 'yellow', 'yl' ],
			[ 'blue', 'blu' ],
			[ 'magenta', 'mg' ],
			[ 'cyan', 'cy' ],
			[ 'light-gray', 'lg' ],
			[ 'dark-gray', 'dg' ],
			[ 'light-red', 'lr' ],
			[ 'light-green', 'lgr' ],
			[ 'light-yellow', 'ly' ],
			[ 'light-blue', 'lb' ],
			[ 'light-magenta', 'lm' ],
			[ 'light-cyan', 'lc' ],
			[ 'white', 'wh' ]
		]) {
			map.set('foreground-color-' + color, 'fg-' + abbreviation);
			map.set('background-color-' + color, 'bg-' + abbreviation);
		}

		for (const [attribute, abbreviation] of [
			[ 'bold', 'bo' ],
			[ 'dim', 'di' ],
			[ 'underlined', 'ul' ],
			[ 'blink', 'bl' ],
			[ 'inverted', 'in' ],
			[ 'hidden', 'hi' ]
		]) {
			map.set('attribute-' + attribute, 'at-' + abbreviation);
		}

		return map;
	}

	private _disposables: vscode.Disposable[] = [];
	private _configuration: ConfigurationManager;

	private _styles: any;
	private _styleKeyMappings: Map<string, string>;
	private _customCss: any;
	private _fontSettings: any;

	constructor(configuration: ConfigurationManager) {
		this._configuration = configuration;
		this._configuration.onReload(() => {
			this.reloadConfiguration();
		}, null, this._disposables);

		this._customCss = { };
		this._styles = new Map();
		this._styleKeyMappings = HTMLContentProvider.generateKeyMappings();

		this.reloadConfiguration();
	}

	public dispose(): void {
		for (const disposable of this._disposables) {
			disposable.dispose();
		}

		this._disposables = [];
	}

	public reloadConfiguration(): void {
		this._customCss = this._configuration.getCustomCss();

		// Convert font settings to CSS class properties
		this._fontSettings = { 'body': this._configuration.getFontSettings() };

		// Convert styles to CSS class properties
		this._styles = this._loadStyles();
	}

	private _loadStyles(): any {
		const styles: [string, any][] = [];

		for (const [key, value] of this._configuration.getSettings()) {
			const previewSettings = value.previewStyle;

			const darkSettingsExist = 'dark' in previewSettings;
			const lightSettingsExist = 'light' in previewSettings;
			const highContrastSettingsExist = 'high-contrast' in previewSettings;

			const shortKey = this._getShortKey(key);

			if (!darkSettingsExist && !lightSettingsExist && !highContrastSettingsExist) {
				// Neither the dark, the light nor the high-contrast settings exists
				// Use the same style for all modes
				styles.push([`.${shortKey}`, previewSettings]);
			} else {
				if (darkSettingsExist && typeof previewSettings['dark'] === 'object') {
					styles.push([`.vscode-dark .${shortKey}`, previewSettings['dark']]);
				} else {
					styles.push([`.vscode-dark .${shortKey}`, {}]);
				}

				if (lightSettingsExist && typeof previewSettings['light'] === 'object') {
					styles.push([`.vscode-light .${shortKey}`, previewSettings['light']]);
				} else {
					styles.push([`.vscode-light .${shortKey}`, {}]);
				}

				if (highContrastSettingsExist && typeof previewSettings['high-contrast'] === 'object') {
					styles.push([`.vscode-high-contrast .${shortKey}`, previewSettings['high-contrast']]);
				} else {
					styles.push([`.vscode-high-contrast .${shortKey}`, {}]);
				}
			}
		}

		return Object.fromEntries(styles);
	}

	private _getShortKey(key: string): string {
		return this._styleKeyMappings.get(key)!;
	}

	/**
	 * Converts the source text to rendered HTML code.
	 * The state parameter contains the editor state when genrating a preview
	 * for the Webview in VS Code.
	 * The state parameter is undefined, when exporting HTML to a file.
	 *
	 * @param document The document to render
	 * @param callback A callback to receive the generated data
	 * @param state The state information, when in preview mode
	 */
	public async provideTextDocumentContent(document: vscode.TextDocument, callback: (data: string) => Promise<void>, state?: any): Promise<void> {
		const cssNonce = this._generateNonce();
		const jsNonce = this._generateNonce();

		// Try to add at least a little bit of security with Content-Security-Policy so that
		// the rendered file can not include arbitrary CSS code
		// JavaScript is disabled by CSP and the WebView settings
		let header = '<html>';
		header += '<head>';
		header += `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${jsNonce}'; style-src 'nonce-${cssNonce}'"></meta>`;
		header += '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
		header += `<title>${this._getFilename(document.uri)}</title>`;
		if (state != null) {
			header += `<script type="text/javascript" nonce="${jsNonce}">acquireVsCodeApi().setState(${JSON.stringify(state)});</script>`;
		}
		header += `<style type="text/css" nonce="${cssNonce}">${this._generateCss(this._styles)}</style>`;
		header += `<style type="text/css" nonce="${cssNonce}">${this._generateCss(this._fontSettings)}</style>`;
		header += `<style type="text/css" nonce="${cssNonce}">${this._generateCss(this._customCss)}</style>`;
		header += '</head>';

		if (state != null) {
			header += '<body>';
		} else {
			header += '<body class="vscode-light">';
		}
		await callback(header);

		await VT100Parser.parse(document, async (range, context) => {
			// Just ignore escape sequences and don't render them
			if (context.get('type') === 'escape-sequence') {
				return;
			}

			const [foregroundColor, backgroundColor] = this._getColors(context);

			const foregroundClasses: string[] = [ ];
			foregroundClasses.push(this._getShortKey('foreground'));
			foregroundClasses.push(this._getShortKey(context.get('type')!));
			foregroundClasses.push(this._getShortKey(`foreground-color-${foregroundColor}`));
			for (const attribute of ['bold', 'dim', 'underlined', 'blink', 'inverted', 'hidden']) {
				if (context.get(attribute) === 'yes') {
					foregroundClasses.push(this._getShortKey('attribute-' + attribute));
				}
			}

			const backgroundClasses: string[] = [ ];
			backgroundClasses.push(this._getShortKey('background'));
			backgroundClasses.push(this._getShortKey(`background-color-${backgroundColor}`));

			let line = `<span class="${backgroundClasses.join(' ')}">`;
			line += `<span class="${foregroundClasses.join(' ')}">`;
			line += this._escapeHtml(this._stripEscapeCodes(document.getText(range)));
			line += '</span></span>';

			if (context.get('line-end') == 'yes') {
				line += '<br>\n';
			}

			await callback(line);
		});

		let footer = '</body>';
		footer += '</html>';
		await callback(footer);
	}

	private _generateNonce(): string {
		const buffer: Buffer = randomBytes(64);
		return buffer.toString('base64');
	}

	private _getColors(context: Map<string, string>): [string, string] {
		let foregroundColor: string;
		let backgroundColor: string;

		if (context.get('inverted') === 'yes') {
			foregroundColor = context.get('background-color')!;
			backgroundColor = context.get('foreground-color')!;

			if (foregroundColor === 'default') {
				foregroundColor = 'inverted';
			}
			if (backgroundColor === 'default') {
				backgroundColor = 'inverted';
			}
		} else {
			foregroundColor = context.get('foreground-color')!;
			backgroundColor = context.get('background-color')!;
		}

		return [foregroundColor, backgroundColor];
	}

	private _generateCss(properties: any): string {
		let css = '';

		for (const [key, value] of Object.entries(properties)) {
			if (value == null) {
				continue;
			}

			if (typeof value === 'object') {
				css += `${key} {\n`;
				css += this._generateCss(value);
				css += `}\n`;
			} else if (typeof value === 'string') {
				css += `${key}: ${value};\n`;
			}
		}

		return css;
	}

	private _escapeHtml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;")
			.replace(/ /g, '&nbsp;');
	}

	private _getFilename(uri: vscode.Uri): string {
		const path = uri.path;
		const separatorIndex = path.lastIndexOf('/');

		if (separatorIndex !== -1) {
			return path.substr(separatorIndex + 1);
		}

		return path;
	}

	private _stripEscapeCodes(text: string): string {
		// See http://ascii-table.com/ansi-escape-sequences-vt-100.php
		// eslint-disable-next-line no-control-regex
		return text.replace(/\x1B\[([0-9?]*[hl]|[0-9;]*[mrHfy]|[0-9]*[ABCDgKJnqi]|[0-9;?]*[c])/g, '')
			// eslint-disable-next-line no-control-regex
			.replace(/\x1B([NODMEHc<=>FGABCDHIKJ]|[()][AB012]|#[0-9]|[0-9;]R|\/?Z|[0-9]+|O[PQRSABCDpqrstuvwxymlnM])/g, '');
	}

}