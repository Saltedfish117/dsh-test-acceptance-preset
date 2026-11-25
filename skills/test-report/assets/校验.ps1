<#
.SYNOPSIS
    校验测试问题报告目录是否符合 test-report 输出规范。

.DESCRIPTION
    检查项：
      1. 文件名 <级别>-<功能类别>-<简要描述>-<状态>.md，四段用半角 - 分隔，长度 <= 60，非保留名；
      2. 状态在固定枚举内；H1 与文件名一致；元信息「当前状态」与文件名状态一致；
      3. 问题级别为 P0-P3 且与文件名一致；
      4. 七个必填二级标题齐全、顺序正确、内容非空，且不重复；
      5. 无 {{占位符}}、无 TBD / 待补充；
      6. 截图必须存在、必须是本地相对路径；
      7. 「初步定位」要写责任方（前端 / 后端 / 前后端 / 需求或产品 / 待确认）并给出可核查依据。
    默认递归扫描目录下的 .md，跳过 README / AGENT_PROMPT / 问题模板 / 以下划线或「模板」「示例」开头的文件。
    本文件以 UTF-8 BOM 保存，PowerShell 7 与 Windows PowerShell 5.1 都能正确读取中文；
    用 5.1 运行时脚本默认被执行策略拦截，需要加 -ExecutionPolicy Bypass。

.PARAMETER Path
    输出目录，或包含多轮批次的上级目录。默认 test。

.EXAMPLE
    pwsh -NoProfile -File ./校验.ps1 -Path test/首轮

.EXAMPLE
    pwsh -NoProfile -File ./校验.ps1 -Path test
#>
[CmdletBinding()]
param(
    [string]$Path = "test"
)

$ErrorActionPreference = "Stop"

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
if (-not $resolved) {
    Write-Host "目录不存在：$Path" -ForegroundColor Red
    exit 1
}

# 文件名：级别 + 功能类别(2-20) + 简要描述(8-20) + 状态；段内禁止分隔符、空格与非法字符
$namePattern = '^(?<level>P[0-3])-(?<category>[^\s\\/:*?"<>|-]{2,20})-(?<desc>[^\s\\/:*?"<>|-]{8,20})-(?<status>待修复|修复中|待验证|已验证|已关闭|不修复|延期)\.md$'
$required = @("问题级别", "文件目录", "问题描述", "预期结果", "实际结果", "初步定位", "问题截图")
$statusValues = @("待修复", "修复中", "待验证", "已验证", "已关闭", "不修复", "延期")
$reservedNames = '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'
$excludeNames = '^(README|AGENT_PROMPT|问题模板|_|模板|示例)'

$files = @(Get-ChildItem -LiteralPath $resolved.Path -Recurse -File -Filter *.md |
    Where-Object { $_.Name -notmatch $excludeNames })

if ($files.Count -eq 0) {
    Write-Host "未找到待校验的 .md 文件：$($resolved.Path)" -ForegroundColor Yellow
    exit 1
}

$passed = 0
$failed = 0
$skipped = 0

foreach ($file in $files) {
    $errors = [System.Collections.Generic.List[string]]::new()
    $name = $file.Name
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
    if ($null -eq $text) { $text = "" }

    # 旧版示例文件直接跳过
    if ($text -match '^\s*#\s*旧版示例') {
        $skipped++
        continue
    }

    $nameMatch = [regex]::Match($name, $namePattern)

    if ($name.Length -gt 60) {
        $errors.Add("文件名过长（$($name.Length) 字符，含 .md 不得超过 60）：$name")
    }
    if (-not $nameMatch.Success) {
        $errors.Add("文件名不符合 <级别>-<功能类别>-<简要描述>-<状态>.md；功能类别 2–20 个字符、描述 8–20 个字符，状态取 待修复/修复中/待验证/已验证/已关闭/不修复/延期；不能含空格、- 或非法字符")
    }
    if ($base -match '[. ]$' -or $base -match '\.\.') {
        $errors.Add("文件名不能以点/空格结尾，也不能含连续点")
    }
    if ($base -match $reservedNames) {
        $errors.Add("文件名使用了 Windows 保留名：$base")
    }

    # H1 必须与文件名（去掉 .md）完全一致
    $h1 = [regex]::Match($text, '(?m)^#[ \t]+(.+?)[ \t]*$')
    if (-not $h1.Success) {
        $errors.Add("缺少 H1 标题")
    } elseif ($h1.Groups[1].Value.Trim() -ne $base) {
        $errors.Add("H1 与文件名不一致：H1=「$($h1.Groups[1].Value.Trim())」，文件名=「$base」")
    }

    if ($text -match '\{\{|\}\}|\bTBD\b|待补充') {
        $errors.Add("仍含占位符、TBD 或「待补充」")
    }

    # 收集二级标题及其内容，用于检查必填段与顺序
    $headings = [regex]::Matches($text, '(?m)^##[ \t]+(.+?)[ \t]*$')
    $sections = [System.Collections.Generic.Dictionary[string, string]]::new()
    $duplicated = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $headings.Count; $i++) {
        $title = $headings[$i].Groups[1].Value.Trim()
        $start = $headings[$i].Index + $headings[$i].Length
        $end = if ($i + 1 -lt $headings.Count) { $headings[$i + 1].Index } else { $text.Length }
        $body = $text.Substring($start, $end - $start).Trim()
        if ($sections.ContainsKey($title)) {
            if (-not $duplicated.Contains($title)) { $duplicated.Add($title) }
        } else {
            $sections[$title] = $body
        }
    }

    foreach ($key in $required) {
        if (-not $sections.ContainsKey($key)) {
            $errors.Add("缺少二级标题：## $key")
        } elseif ([string]::IsNullOrWhiteSpace($sections[$key])) {
            $errors.Add("内容为空：## $key")
        }
    }
    foreach ($key in $duplicated) {
        $errors.Add("二级标题重复：## $key")
    }

    $ordered = @($headings | ForEach-Object { $_.Groups[1].Value.Trim() } | Where-Object { $required -contains $_ })
    if (($ordered -join '|') -ne ($required -join '|')) {
        $errors.Add("二级标题顺序应为：" + ($required -join " → "))
    }

    # 问题级别必须是 P0-P3，且与文件名级别一致
    if ($sections.ContainsKey("问题级别")) {
        $levelMatch = [regex]::Match($sections["问题级别"], '^\s*(?:\*\*)?(?<level>P[0-3])')
        if (-not $levelMatch.Success) {
            $errors.Add("「问题级别」未写 P0–P3")
        } elseif ($nameMatch.Success -and $levelMatch.Groups["level"].Value -ne $nameMatch.Groups["level"].Value) {
            $errors.Add("问题级别与文件名不一致：正文 $($levelMatch.Groups['level'].Value)，文件名 $($nameMatch.Groups['level'].Value)")
        }
    }

    # 元信息「当前状态」必须与文件名状态一致
    $statusRow = [regex]::Match($text, '(?m)^\|\s*当前状态\s*\|\s*(?<status>[^|\r\n]+?)\s*\|')
    if ($statusRow.Success -and $nameMatch.Success) {
        $metaStatus = $statusRow.Groups["status"].Value.Trim()
        if (-not ($statusValues -contains $metaStatus)) {
            $errors.Add("元信息「当前状态」不在枚举内：$metaStatus")
        } elseif ($metaStatus -ne $nameMatch.Groups["status"].Value) {
            $errors.Add("元信息「当前状态」与文件名状态不一致：元信息 $metaStatus，文件名 $($nameMatch.Groups['status'].Value)")
        }
    }

    # 「初步定位」：要给出责任方与可核查依据，不能只复述现象
    if ($sections.ContainsKey("初步定位")) {
        $position = $sections["初步定位"]
        if ($position -notmatch '前端|后端|需求|产品|待确认') {
            $errors.Add("「初步定位」没写责任方（前端 / 后端 / 前后端都有 / 需求或产品 / 待确认）")
        }
        if ($position -notmatch '依据|证据|源码|接口|响应|日志|返回|报错') {
            $errors.Add("「初步定位」没给判定依据（接口响应关键字段、源码路径:行号或日志原文）")
        }
    }

    # 截图：必须是本地相对路径且文件真实存在；无图必须写原因
    if ($sections.ContainsKey("问题截图")) {
        $shot = $sections["问题截图"]
        $images = [regex]::Matches($shot, '!\[[^\]]*\]\(([^)]+)\)')
        if ($images.Count -eq 0) {
            if ($shot -notmatch '未截图说明\s*[:：]\s*\S+') {
                $errors.Add("「问题截图」没有图片，也没有「未截图说明：原因」")
            }
        } else {
            foreach ($img in $images) {
                $link = $img.Groups[1].Value.Trim().Trim('<', '>')
                if ($link -match '^https?://') {
                    $errors.Add("截图必须保存到本地 截图/ 目录，不能使用网络链接：$link")
                    continue
                }
                try {
                    $localPath = [System.Uri]::UnescapeDataString($link)
                } catch {
                    $localPath = $link
                }
                $imgPath = Join-Path $file.DirectoryName $localPath
                if (-not (Test-Path -LiteralPath $imgPath)) {
                    $errors.Add("截图不存在：$link")
                }
            }
        }
    }

    if ($errors.Count -gt 0) {
        Write-Host "FAIL  $name" -ForegroundColor Red
        foreach ($e in $errors) { Write-Host "      - $e" -ForegroundColor Red }
        $failed++
    } else {
        Write-Host "PASS  $name" -ForegroundColor Green
        $passed++
    }
}

Write-Host ""
Write-Host "共校验 $($files.Count) 个文件：通过 $passed，失败 $failed，跳过 $skipped" -ForegroundColor Cyan
if ($failed -gt 0) { exit 1 }
