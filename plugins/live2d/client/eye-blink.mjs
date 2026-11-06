export class EyeBlinkEngine {
	constructor(options = {}) {
		this.enabled = options.enabled !== false;

		this.state = "idle";
		this.stateTime = 0;

		this.closingDuration = options.closingDuration || 75;
		this.closedDuration = options.closedDuration || 25;
		this.openingDuration = options.openingDuration || 135;

		this.minInterval = options.minInterval || 2400;
		this.maxInterval = options.maxInterval || 5200;
		this.doubleBlinkChance = options.doubleBlinkChance ?? 0.2;

		this.nextBlinkTimer = this._getRandomInterval();
		this.pendingDoubleBlink = false;

		this.leftOpen = 1.0;
		this.rightOpen = 1.0;

		this.winkSide = null;
		this.winkDuration = 550;
		this.winkTimer = 0;
	}

	_getRandomInterval() {
		return this.minInterval + Math.random() * (this.maxInterval - this.minInterval);
	}

	triggerBlink() {
		if (this.state === "idle") {
			this.state = "closing";
			this.stateTime = 0;
			this.winkSide = null;
		}
	}

	triggerWink(side = "right") {
		this.winkSide = side === "left" ? "left" : "right";
		this.winkTimer = this.winkDuration;
	}

	onMusicBeat() {
		if (!this.enabled || this.state !== "idle" || this.winkSide) return;
		if (this.nextBlinkTimer > 1000 && Math.random() < 0.28) {
			this.triggerBlink();
		}
	}

	setEnabled(val) {
		this.enabled = Boolean(val);
		if (!this.enabled) {
			this.leftOpen = 1.0;
			this.rightOpen = 1.0;
			this.state = "idle";
			this.winkSide = null;
		}
	}

	/**
	 * 每一帧渲染循环调用，更新眨眼状态机
	 * @param {number} deltaMs 距离上一帧的时间跨度 (毫秒)
	 * @returns {{ left: number, right: number }} 左右眼开合系数 [0.0 ~ 1.0]
	 */
	update(deltaMs) {
		if (!this.enabled) {
			return { left: 1.0, right: 1.0 };
		}

		const dt = Math.min(deltaMs, 100);

		if (this.winkSide) {
			this.winkTimer -= dt;
			if (this.winkTimer <= 0) {
				this.winkSide = null;
				this.leftOpen = 1.0;
				this.rightOpen = 1.0;
			} else {
				const progress = 1 - this.winkTimer / this.winkDuration;
				let ratio = 0;
				if (progress < 0.15) {
					ratio = 1 - progress / 0.15;
				} else if (progress > 0.75) {
					ratio = (progress - 0.75) / 0.25;
				} else {
					ratio = 0;
				}

				if (this.winkSide === "left") {
					this.leftOpen = ratio;
					this.rightOpen = 1.0;
				} else {
					this.leftOpen = 1.0;
					this.rightOpen = ratio;
				}
				return { left: this.leftOpen, right: this.rightOpen };
			}
		}

		this.stateTime += dt;

		switch (this.state) {
			case "idle": {
				this.leftOpen = 1.0;
				this.rightOpen = 1.0;
				this.nextBlinkTimer -= dt;

				if (this.nextBlinkTimer <= 0) {
					this.state = "closing";
					this.stateTime = 0;
				}
				break;
			}

			case "closing": {
				const progress = Math.min(1.0, this.stateTime / this.closingDuration);
				const easeClose = Math.pow(1 - progress, 1.8);
				this.leftOpen = easeClose;
				this.rightOpen = easeClose;

				if (progress >= 1.0) {
					this.state = "closed";
					this.stateTime = 0;
					this.leftOpen = 0.0;
					this.rightOpen = 0.0;
				}
				break;
			}

			case "closed": {
				this.leftOpen = 0.0;
				this.rightOpen = 0.0;

				if (this.stateTime >= this.closedDuration) {
					this.state = "opening";
					this.stateTime = 0;
				}
				break;
			}

			case "opening": {
				const progress = Math.min(1.0, this.stateTime / this.openingDuration);
				const easeOpen = Math.sin((progress * Math.PI) / 2);
				this.leftOpen = easeOpen;
				this.rightOpen = easeOpen;

				if (progress >= 1.0) {
					this.state = "idle";
					this.stateTime = 0;
					this.leftOpen = 1.0;
					this.rightOpen = 1.0;

					if (this.pendingDoubleBlink) {
						this.pendingDoubleBlink = false;
						this.nextBlinkTimer = this._getRandomInterval();
					} else if (Math.random() < this.doubleBlinkChance) {
						this.pendingDoubleBlink = true;
						this.nextBlinkTimer = 110;
					} else {
						this.nextBlinkTimer = this._getRandomInterval();
					}
				}
				break;
			}
		}

		return {
			left: Math.max(0.0, Math.min(1.0, this.leftOpen)),
			right: Math.max(0.0, Math.min(1.0, this.rightOpen)),
		};
	}
}
