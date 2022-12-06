import {showProgressDialog} from "../../../gui/dialogs/ProgressDialog.js"
import {GroupType, SecondFactorType} from "../../../api/common/TutanotaConstants.js"
import type {DropDownSelectorAttrs, SelectorItem} from "../../../gui/base/DropDownSelector.js"
import {DropDownSelector} from "../../../gui/base/DropDownSelector.js"
import type {TranslationKey} from "../../../misc/LanguageViewModel.js"
import {lang} from "../../../misc/LanguageViewModel.js"
import type {TextFieldAttrs} from "../../../gui/base/TextField.js"
import {TextField} from "../../../gui/base/TextField.js"
import {isApp, isTutanotaDomain} from "../../../api/common/Env.js"
import m, {Children} from "mithril"
import {Button, ButtonType} from "../../../gui/base/Button.js"
import {copyToClipboard} from "../../../misc/ClipboardUtils.js"
import {Icons} from "../../../gui/base/icons/Icons.js"
import QRCode from "qrcode-svg"
import {htmlSanitizer} from "../../../misc/HtmlSanitizer.js"
import {Dialog, DialogType} from "../../../gui/base/Dialog.js"
import {Icon, progressIcon} from "../../../gui/base/Icon.js"
import {theme} from "../../../gui/theme.js"
import type {U2fRegisteredDevice, User} from "../../../api/entities/sys/TypeRefs.js"
import {createSecondFactor, GroupInfoTypeRef} from "../../../api/entities/sys/TypeRefs.js"
import {assertNotNull, LazyLoaded, neverNull} from "@tutao/tutanota-utils"
import {locator} from "../../../api/main/MainLocator.js"
import {getEtId, isSameId} from "../../../api/common/utils/EntityUtils.js"
import {logins} from "../../../api/main/LoginController.js"
import * as RecoverCodeDialog from "../RecoverCodeDialog.js"
import {validateWebauthnDisplayName, WebauthnClient} from "../../../misc/2fa/webauthn/WebauthnClient.js"
import {EntityClient} from "../../../api/common/EntityClient.js"
import {ProgrammingError} from "../../../api/common/error/ProgrammingError.js"
import type {TotpSecret} from "@tutao/tutanota-crypto"
import {IconButton, IconButtonAttrs} from "../../../gui/base/IconButton.js"
import {ButtonSize} from "../../../gui/base/ButtonSize.js"

const enum VerificationStatus {
	Initial = "Initial",
	Progress = "Progress",
	Failed = "Failed",
	Success = "Success",
}

const DEFAULT_U2F_NAME = "U2F"
const DEFAULT_TOTP_NAME = "TOTP"

const NameValidationStatus: Record<string, TranslationKey> = {
	Valid: "secondFactorNameInfo_msg",
	Invalid: "textTooLong_msg"
} as const

/** Enum with user-visible types because we don't allow adding SecondFactorType.u2f anymore */
const FactorTypes = {
	WEBAUTHN: SecondFactorType.webauthn,
	TOTP: SecondFactorType.totp,
} as const

type FactorTypesEnum = Values<typeof FactorTypes>

export class EditSecondFactorDialog {
	private readonly dialog: Dialog
	private helpKey: TranslationKey = NameValidationStatus.Valid
	private helpLabelSelector = ""
	private selectedType: FactorTypesEnum
	private verificationStatus: VerificationStatus = VerificationStatus.Initial
	private u2fRegistrationData: U2fRegisteredDevice | null = null
	private name: string = ""
	private totpCode: string = ""
	private readonly otpInfo: LazyLoaded<{
		qrCodeSvg: string | null
		url: string
	}>

	constructor(
		private readonly entityClient: EntityClient,
		private readonly user: User,
		private readonly mailAddress: string,
		private readonly webauthnClient: WebauthnClient,
		private readonly totpKeys: TotpSecret,
		private readonly webauthnSupported: boolean,
	) {
		this.selectedType = webauthnSupported ? FactorTypes.WEBAUTHN : FactorTypes.TOTP
		this.setDefaultNameIfNeeded()
		this.otpInfo = new LazyLoaded(async () => {
			const url = await this.getOtpAuthUrl(this.totpKeys.readableKey)
			let totpQRCodeSvg

			if (!isApp()) {
				let qrcodeGenerator = new QRCode({
					height: 150,
					width: 150,
					content: url,
					padding: 2,
					// We don't want <xml> around the content, we actually enforce <svg> namespace and we want it to be parsed as such.
					xmlDeclaration: false,
				})
				totpQRCodeSvg = htmlSanitizer.sanitizeSVG(qrcodeGenerator.svg()).html
			} else {
				totpQRCodeSvg = null
			}

			return {
				qrCodeSvg: totpQRCodeSvg,
				url,
			}
		})

		this.otpInfo.getAsync().then(() => m.redraw())

		this.dialog = Dialog.createActionDialog({
			title: lang.get("add_action"),
			allowOkWithReturn: true,
			child: {
				view: () => this.render(),
			},
			okAction: () => this.save(),
			allowCancel: true,
			okActionTextId: "save_action",
			cancelAction: () => this.webauthnClient.abortCurrentOperation(),
			validator: () => this.updateNameValidation()
		})
	}

	static loadAndShow(entityClient: EntityClient, lazyUser: LazyLoaded<User>, mailAddress: string) {
		showProgressDialog("pleaseWait_msg", this.loadWebauthnClient(entityClient, lazyUser, mailAddress))
			.then((dialog) => {
				dialog.dialog.show()
			})
	}

	private async save() {
		this.setDefaultNameIfNeeded()
		if (this.selectedType === FactorTypes.WEBAUTHN) {
			// Prevent starting in parallel
			if (this.verificationStatus === VerificationStatus.Progress) {
				return
			}

			try {
				this.u2fRegistrationData = await this.webauthnClient.register(this.user._id, this.name)
				this.verificationStatus = VerificationStatus.Success
			} catch (e) {
				console.log("Webauthn registration failed: ", e)
				this.u2fRegistrationData = null
				this.verificationStatus = VerificationStatus.Failed
			}
		}

		m.redraw()
		const sf = createSecondFactor({
			_ownerGroup: this.user._ownerGroup,
			name: this.name,
		})

		if (this.selectedType === FactorTypes.WEBAUTHN) {
			sf.type = SecondFactorType.webauthn

			if (this.verificationStatus !== VerificationStatus.Success) {
				// noinspection ES6MissingAwait
				Dialog.message("unrecognizedU2fDevice_msg")
				return
			} else {
				sf.u2f = this.u2fRegistrationData
			}
		} else if (this.selectedType === FactorTypes.TOTP) {
			sf.type = SecondFactorType.totp

			if (this.verificationStatus !== VerificationStatus.Success) {
				// noinspection ES6MissingAwait
				Dialog.message("totpCodeEnter_msg")
				return
			} else {
				sf.otpSecret = this.totpKeys.key
			}
		} else {
			throw new ProgrammingError("")
		}

		await showProgressDialog("pleaseWait_msg", this.entityClient.setup(assertNotNull(this.user.auth).secondFactors, sf))

		this.dialog.close()

		this.showRecoveryInfoDialog(this.user)
	}

	private render(): Children {
		const options: Array<SelectorItem<FactorTypesEnum>> = []
		options.push({
			name: lang.get("totpAuthenticator_label"),
			value: FactorTypes.TOTP,
		})

		if (this.webauthnSupported) {
			options.push({
				name: lang.get("u2fSecurityKey_label"),
				value: FactorTypes.WEBAUTHN,
			})
		}

		const typeDropdownAttrs: DropDownSelectorAttrs<FactorTypesEnum> = {
			label: "type_label",
			selectedValue: this.selectedType,
			selectionChangedHandler: newValue => this.onTypeSelected(newValue),
			items: options,
			dropdownWidth: 300,
		}
		const nameFieldAttrs: TextFieldAttrs = {
			label: "name_label",
			helpLabel: () => m(this.helpLabelSelector, lang.get(this.helpKey)),
			value: this.name,
			oninput: value => {
				this.name = value
				this.updateNameValidation()
			},
		}
		return [m(DropDownSelector, typeDropdownAttrs), m(TextField, nameFieldAttrs), this.renderTypeSpecificFields()]
	}

	private renderTypeSpecificFields(): Children {
		switch (this.selectedType) {
			case FactorTypes.TOTP:
				return this.renderOtpFields()

			case FactorTypes.WEBAUTHN:
				return this.renderU2FFields()

			default:
				throw new ProgrammingError(`Invalid 2fa type: ${this.selectedType}`)
		}
	}

	private renderU2FFields(): Children {
		// Only show progress for u2f because success/error will show another dialog
		if (this.verificationStatus !== VerificationStatus.Progress) {
			return null
		} else {
			return m("p.flex.items-center", [m(".mr-s", this.statusIcon()), m("", this.statusMessage())])
		}
	}

	private renderOtpFields(): Children {
		const copyButtonAttrs: IconButtonAttrs = {
			title: "copy_action",
			click: () => copyToClipboard(this.totpKeys.readableKey),
			icon: Icons.Clipboard,
			size: ButtonSize.Compact,
		}
		return m(".mb", [
			m(TextField, {
				label: "totpSecret_label",
				helpLabel: () => lang.get(isApp() ? "totpTransferSecretApp_msg" : "totpTransferSecret_msg"),
				value: this.totpKeys.readableKey,
				injectionsRight: () => m(IconButton, copyButtonAttrs),
				disabled: true,
			}),
			isApp()
				? m(".pt", m(Button, {
					label: "addOpenOTPApp_action",
					click: () => this.openOtpLink(),
					type: ButtonType.Login,
				}))
				: this.renderOtpQrCode(),
			m(TextField, {
				label: "totpCode_label",
				value: this.totpCode,
				oninput: newValue => this.onTotpValueChange(newValue),
			}),
		])
	}

	private renderOtpQrCode(): Children {
		const otpInfo = this.otpInfo.getSync()

		if (otpInfo) {
			const qrCodeSvg = assertNotNull(otpInfo.qrCodeSvg)
			// sanitized above
			return m(".flex-center.pt-m", m.trust(qrCodeSvg))
		} else {
			return null
		}
	}

	private async openOtpLink() {
		const {url} = await this.otpInfo.getAsync()
		const successful = await locator.systemFacade.openLink(url)

		if (!successful) {
			// noinspection ES6MissingAwait
			Dialog.message("noAppAvailable_msg")
		}
	}

	private async onTotpValueChange(newValue: string) {
		this.totpCode = newValue
		let cleanedValue = newValue.replace(/ /g, "")

		if (cleanedValue.length === 6) {
			const expectedCode = Number(cleanedValue)
			this.verificationStatus = await this.tryCodes(expectedCode, this.totpKeys.key)
		} else {
			this.verificationStatus = VerificationStatus.Progress
		}
	}

	private onTypeSelected(newValue: FactorTypesEnum) {
		this.selectedType = newValue
		this.verificationStatus = newValue === FactorTypes.WEBAUTHN
			? VerificationStatus.Initial
			: VerificationStatus.Progress

		this.updateNameValidation()
		this.setDefaultNameIfNeeded()

		if (newValue !== FactorTypes.WEBAUTHN) {
			// noinspection JSIgnoredPromiseFromCall
			this.webauthnClient.abortCurrentOperation()
		}
	}

	private static async loadWebauthnClient(entityClient: EntityClient, lazyUser: LazyLoaded<User>, mailAddress: string): Promise<EditSecondFactorDialog> {
		const totpKeys = await locator.loginFacade.generateTotpSecret()
		const user = await lazyUser.getAsync()
		const webauthnSupported = await locator.webAuthn.isSupported()
		return new EditSecondFactorDialog(entityClient, user, mailAddress, locator.webAuthn, totpKeys, webauthnSupported)
	}

	private showRecoveryInfoDialog(user: User) {
		// We only show the recovery code if it is for the current user and it is a global admin
		if (!isSameId(getEtId(logins.getUserController().user), getEtId(user)) || !user.memberships.find(gm => gm.groupType === GroupType.Admin)) {
			return
		}

		const isRecoverCodeAvailable = user.auth && user.auth.recoverCode != null
		Dialog.showActionDialog({
			title: lang.get("recoveryCode_label"),
			type: DialogType.EditMedium,
			child: () => m(".pt", lang.get("recoveryCode_msg")),
			allowOkWithReturn: true,
			okAction: (dialog: Dialog) => {
				dialog.close()
				RecoverCodeDialog.showRecoverCodeDialogAfterPasswordVerification(isRecoverCodeAvailable ? "get" : "create", false)
			},
			okActionTextId: isRecoverCodeAvailable ? "show_action" : "setUp_action",
		})
	}

	private async tryCodes(expectedCode: number, key: Uint8Array): Promise<VerificationStatus> {
		const {loginFacade} = locator
		const time = Math.floor(new Date().getTime() / 1000 / 30)
		// We try out 3 codes: current minute, 30 seconds before and 30 seconds after.
		// If at least one of them works, we accept it.
		const number = await loginFacade.generateTotpCode(time, key)

		if (number === expectedCode) {
			return VerificationStatus.Success
		}

		const number2 = await loginFacade.generateTotpCode(time - 1, key)

		if (number2 === expectedCode) {
			return VerificationStatus.Success
		}

		const number3 = await loginFacade.generateTotpCode(time + 1, key)

		if (number3 === expectedCode) {
			return VerificationStatus.Success
		}

		return VerificationStatus.Failed
	}

	/** see https://github.com/google/google-authenticator/wiki/Key-Uri-Format */
	private async getOtpAuthUrl(secret: string): Promise<string> {
		const userGroupInfo = await this.entityClient.load(GroupInfoTypeRef, this.user.userGroup.groupInfo)
		const issuer = isTutanotaDomain() ? "Tutanota" : location.hostname
		const account = encodeURI(issuer + ":" + neverNull(userGroupInfo.mailAddress))
		const url = new URL("otpauth://totp/" + account)
		url.searchParams.set("issuer", issuer)
		url.searchParams.set("secret", secret.replace(/ /g, ""))
		url.searchParams.set("algorithm", "SHA1")
		url.searchParams.set("digits", "6")
		url.searchParams.set("period", "30")
		return url.toString()
	}

	private statusIcon(): Children {
		switch (this.verificationStatus) {
			case VerificationStatus.Progress:
				return progressIcon()

			case VerificationStatus.Success:
				return m(Icon, {
					icon: Icons.Checkmark,
					large: true,
					style: {
						fill: theme.content_accent,
					},
				})

			case VerificationStatus.Failed:
				return m(Icon, {
					icon: Icons.Cancel,
					large: true,
					style: {
						fill: theme.content_accent,
					},
				})

			default:
				return null
		}
	}

	/**
	 * empty names sometimes lead to errors, so we make sure we have something semi-sensible set in the field.
	 */
	private setDefaultNameIfNeeded() {
		const trimmed = this.name.trim()
		if (this.selectedType === SecondFactorType.webauthn && (trimmed === DEFAULT_TOTP_NAME || trimmed.length === 0)) {
			this.name = DEFAULT_U2F_NAME
		} else if (this.selectedType === SecondFactorType.totp && (trimmed === DEFAULT_U2F_NAME || trimmed.length === 0)) {
			this.name = DEFAULT_TOTP_NAME
		}
	}

	private statusMessage(): string {
		if (this.selectedType === SecondFactorType.webauthn) {
			return this.verificationStatus === VerificationStatus.Success ? lang.get("registeredU2fDevice_msg") : lang.get("registerU2fDevice_msg")
		} else {
			if (this.verificationStatus === VerificationStatus.Success) {
				return lang.get("totpCodeConfirmed_msg")
			} else if (this.verificationStatus === VerificationStatus.Failed) {
				return lang.get("totpCodeWrong_msg")
			} else {
				return lang.get("totpCodeEnter_msg")
			}
		}
	}

	private updateNameValidation(): TranslationKey | null {
		if (this.selectedType !== SecondFactorType.webauthn || validateWebauthnDisplayName(this.name)) {
			this.helpKey = NameValidationStatus.Valid
			this.helpLabelSelector = ""
			return null
		} else {
			this.helpKey = NameValidationStatus.Invalid
			this.helpLabelSelector = ".primary"
			return NameValidationStatus.Invalid
		}
	}
}

export const SecondFactorTypeToNameTextId: Record<SecondFactorType, TranslationKey> = Object.freeze({
	[SecondFactorType.totp]: "totpAuthenticator_label",
	[SecondFactorType.u2f]: "u2fSecurityKey_label",
	[SecondFactorType.webauthn]: "u2fSecurityKey_label",
})