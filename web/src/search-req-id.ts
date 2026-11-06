let searchReqCounter = 1;

export function nextSearchReqId(): number {
	return ++searchReqCounter;
}
