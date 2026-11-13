// Keep useful provider validation details without retaining credentials or response dumps.
const explanations = {
    MS42201: '收件邮箱重复，请检查收件人列表。',
    MS42202: '邮件附件的文件名与内容类型不匹配。',
    MS42204: 'MailerSend账号已达到邮件发送额度，请到平台核对额度。',
    MS42205: '单封邮件的收件人数超过账号当前允许的数量。',
    MS42207: '发件地址所属域名未通过MailerSend验证，请核对测试发件邮箱和Token所属域名。',
    MS42208: '发件或收件邮箱未通过MailerSend的邮箱格式校验。',
    MS42210: 'MailerSend不支持本次附件的文件类型。',
    MS42212: '本次测试要求收件邮箱的域名已在MailerSend验证，请核对平台的测试方式和域名限制。',
    MS42215: '邮件附件未通过Base64编码校验。',
    MS42216: '账号当前套餐不支持本次请求中的功能，请到MailerSend核对套餐限制。',
    MS42222: 'MailerSend测试发信域名的邮件额度已用完。',
    MS42225: '沙盒累计不同收件邮箱数量已达上限。限制累计的是不同邮箱地址，不是本封邮件的人数；请使用平台已登记的测试收件人，或完成账号审批并配置已验证的发信域名。',
};
export function mailFailure(status, result, token) {
    const body = result && typeof result === 'object' ? result : {};
    const clean = (value) => value.split(token).join('[密钥已隐藏]')
        .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [密钥已隐藏]')
        .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 800);
    const details = [];
    if (typeof body.message === 'string' && body.message.trim())
        details.push(clean(body.message));
    if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
        for (const [field, value] of Object.entries(body.errors).slice(0, 8)) {
            const label = /^[a-zA-Z][\w.*-]{0,99}$/.test(field) ? clean(field) : '参数';
            for (const message of (Array.isArray(value) ? value : [value]).slice(0, 3)) {
                if (typeof message === 'string' && message.trim())
                    details.push(`${label}: ${clean(message)}`);
            }
        }
    }
    const detail = [...new Set(details)].join('；').slice(0, 1600);
    const codes = [...new Set(detail.match(/\bMS\d{5}\b/g) || [])];
    let explanation = codes.map(code => explanations[code]).filter(Boolean).join(' ');
    if (!explanation) {
        if (status === 401)
            explanation = 'API Token无效或已过期，请重新填写。';
        else if (status === 403)
            explanation = '账号或Token无权执行本次发信，请核对发送权限及账号状态。';
        else if (status === 429)
            explanation = '请求过于频繁或已达额度，请稍后再试或到平台核对额度。';
        else if (body.errors && typeof body.errors === 'object' && 'from.email' in body.errors)
            explanation = '发件地址未通过校验，请复制MailerSend测试示例中的完整发件邮箱。';
        else
            explanation = '请根据平台详情核对发件参数与账号限制。';
    }
    return `MailerSend拒绝本次发送（${status}${codes.length ? ` / ${codes.join(', ')}` : ''}）：${explanation}${detail ? ` 平台详情：${detail}` : ' 平台未提供可读取的错误详情。'}`;
}
