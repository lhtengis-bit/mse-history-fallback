// Pure text builder for the history fallback alert email. No I/O, no environment, no clock.
//
// Summary = { runDate: string, status: 'healthy'|'repaired'|'flagged'|'mse-unreachable'|'write-failed'|'non-trading-day'|'dry-run',
//             inserts: number, updates: number, anomalies: {key, stored, mse}[], duplicateKeys: string[],
//             newListings: string[], skippedNoTimestamp: string[], reason?: string }
// buildFallbackEmail(summary) -> { subject, html } | null   (null: nothing to send)

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c])

const STYLE = `
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 800px; margin: 0 auto; padding: 20px; }
          .header { font-size: 18px; font-weight: bold; margin-bottom: 20px; }
          .content { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .footer { margin-top: 20px; font-size: 14px; color: #666; }
          .ok { color: #1a7f37; }
          .warn { color: #c53030; }`

const listBlock = (title, items) => items.length === 0 ? '' : `
            <p>${title} (<strong>${items.length}</strong>):</p>
            <pre style="white-space: pre-wrap; font-size: 12px;">${items.map(esc).join('\n')}</pre>`

const anomalyBlock = (anomalies) => anomalies.length === 0 ? '' : `
            <p>Хадгалсан хэмжээ MSE-ээс өндөр байгаа мөрүүд (<strong>${anomalies.length}</strong>), өөрчлөөгүй:</p>
            <pre style="white-space: pre-wrap; font-size: 12px;">${anomalies.map((a) => `${esc(a.key)}  хадгалсан: ${esc(a.stored)}  MSE: ${esc(a.mse)}`).join('\n')}</pre>`

const page = (cls, headline, body) => `
    <html>
      <head>
        <style>${STYLE}
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            Сайн байна уу?
          </div>
          <div class="content">
            <p class="${cls}">${headline}</p>${body}
          </div>
          <div class="footer">
            <p>Өдрийг сайхан өнгөрүүлээрэй.</p>
            <p>BDSec JSC</p>
          </div>
        </div>
      </body>
    </html>`

function buildFallbackEmail (summary) {
  const { status } = summary
  if (status !== 'repaired' && status !== 'flagged' && status !== 'mse-unreachable' && status !== 'write-failed') return null

  const date = esc(summary.runDate)
  const inserts = Number(summary.inserts) || 0
  const updates = Number(summary.updates) || 0
  const anomalies = summary.anomalies || []
  const duplicateKeys = summary.duplicateKeys || []
  const newListings = summary.newListings || []
  const skipped = summary.skippedNoTimestamp || []

  if (status === 'mse-unreachable') {
    return {
      subject: `Арилжааны түүх: MSE-ээс дата авч чадсангүй - ${summary.runDate}`,
      html: page('warn', 'MSE-ийн API-аас арилжааны дата авч чадсангүй!', `
            <p>Огноо: <strong>${date}</strong></p>
            <p>Шалтгаан: ${esc(summary.reason)}</p>
            <p>Түүхийн хүснэгтэд юу ч бичээгүй.</p>`)
    }
  }

  if (status === 'write-failed') {
    return {
      subject: `Арилжааны түүх: MSE-ийн датаг хүснэгтэд бичиж чадсангүй - ${summary.runDate}`,
      html: page('warn', 'MSE-ээс нөхсөн датаг түүхийн хүснэгтэд бичиж чадсангүй!', `
            <p>Огноо: <strong>${date}</strong></p>
            <p>Шалтгаан: ${esc(summary.reason)}</p>
            <p>Хүснэгтэд өгөгдөл хэсэгчлэн бичигдсэн байж магадгүй тул хүснэгтийг гараар шалгана уу.</p>`)
    }
  }

  const detail = `
            <p>Огноо: <strong>${date}</strong></p>
            <p>Шинээр нэмсэн: <strong>${inserts}</strong> ширхэг</p>
            <p>Шинэчилсэн: <strong>${updates}</strong> ширхэг</p>${listBlock('Шинээр бүртгэгдсэн (өмнө түүхгүй) Symbol-ууд', newListings)}${anomalyBlock(anomalies)}${listBlock('Давхардсан түлхүүрүүд', duplicateKeys)}${listBlock('Арилжааны цаггүй тул алгассан Symbol-ууд', skipped)}`

  if (status === 'repaired') {
    return {
      subject: `Арилжааны түүх нөхөгдлөө (${inserts} шинэ, ${updates} шинэчлэгдсэн) - ${summary.runDate}`,
      html: page('ok', 'Арилжааны түүхийн дутуу датаг MSE-ээс нөхлөө.', detail)
    }
  }
  return {
    subject: `Арилжааны түүх: шалгах зүйл байна (${anomalies.length} зөрүү, ${inserts} шинэ, ${updates} шинэчлэгдсэн) - ${summary.runDate}`,
    html: page('warn', 'Арилжааны түүхэд гараар шалгах мөр илэрлээ!', detail)
  }
}

module.exports = { buildFallbackEmail }
