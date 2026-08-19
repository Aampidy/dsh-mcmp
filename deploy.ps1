# dsh-mcmp 一键部署脚本:把本仓库(插件包)安装到 DSH 用户配置层
# 用法:在本仓库目录执行  .\deploy.ps1
# 脚本执行三件事:复制插件文件 → 建立 node_modules junction → 注册 cordis.patch.yml 插件行
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$home = $env:DSH_HOME
if (-not $home) { $home = Join-Path $env:USERPROFILE '.dsh' }
$target = Join-Path $home 'profiles\web\plugins\dsh-mcmp'
$link = Join-Path $home 'profiles\node_modules\dsh-mcmp'
$patch = Join-Path $home 'profiles\web\cordis.patch.yml'

if (-not (Test-Path (Join-Path $home 'profiles\web'))) {
  throw "未找到 $home\profiles\web —— 请先运行一次 dsh web 生成 profile"
}

# 1. 复制插件文件(仓库根目录即插件包)
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $repo 'package.json') $target -Force
Copy-Item (Join-Path $repo 'lib') $target -Recurse -Force

# 2. 建立 junction(供 cordis 按包名 dsh-mcmp 解析)
if (Test-Path $link) {
  if ((Get-Item $link).LinkType -ne 'Junction') {
    throw "$link 已存在且不是 junction,请手动处理后重试"
  }
  Write-Host 'junction 已存在,跳过'
} else {
  cmd /c mklink /J $link $target | Out-Null
  if (-not (Test-Path $link)) { throw 'junction 创建失败' }
  Write-Host 'junction 已创建'
}

# 3. 注册插件行(必须用 insert 列表语法;已注册则跳过)
if (-not (Test-Path $patch)) { throw "未找到 $patch" }
$content = Get-Content $patch -Raw
if ($content -notmatch 'name:\s*dsh-mcmp') {
  Add-Content -Path $patch -Value "`n# 数学建模论文自动化流水线(由 deploy.ps1 注册)`n- insert:`n    - id: mcmp`n      name: dsh-mcmp"
  Write-Host 'cordis.patch.yml 已注册插件行'
} else {
  Write-Host '插件行已存在,跳过'
}

Write-Host ''
Write-Host '部署完成。下一步:'
Write-Host '  1. 重启 dsh web(结束进程后重新运行 dsh web)'
Write-Host '  2. 刷新网页'
Write-Host '  3. 验证:浏览器访问 /mcmp-api/state,返回 JSON 即安装成功'
