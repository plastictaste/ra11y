/*
 * Sanitized repro of jquery.fancybox.pack.js line-4 style: the packed
 * library's iframe-builder writes a string literal whose payload looks
 * like `<iframe id="fancybox-frame{rnd}" name="fancybox-frame{rnd}"
 * ...></iframe>`. The field report on website-templates surfaced this
 * as an iframe review candidate for 1.2.x, even though the iframe is
 * never a DOM element in source — it's string text handed to jQuery
 * at runtime. The fix is to skip the finder on non-DOM-origin file
 * extensions (`.js`, `.ts`); per AI-first doctrine the agent reads the
 * library file directly when investigating.
 */
(function($){$.fn.fancybox=function(){var html='<iframe id="fancybox-frame'+(new Date()).getTime()+'" name="fancybox-frame'+(new Date()).getTime()+'" frameborder="0" hspace="0"'+($.browser.msie?' allowtransparency="true"':"")+' src="'+href+'"></iframe>';$("#fancybox-content").html(html);};})(jQuery);
